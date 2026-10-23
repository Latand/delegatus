import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { activeClaudeAccountId, createManagedClaudeAccount, listClaudeAccounts } from "@/lib/accounts/claude";
import { activeCodexAccountId, createManagedCodexAccount, listCodexAccounts, setActiveCodexAccount } from "@/lib/accounts/codex";
import { CODEX_ACCOUNTS_SOURCE, readAccountSource, writeAccountSource } from "@/lib/accounts/accountsStore";
import { accountProjectBindings, allowedAccountIdsForProject, bindAccountToProject } from "@/lib/accounts/projectBindings";
import { ensureLegacyCollectionsImported } from "@/lib/state/legacyCollections";

import {
  accountExporter, accountReportRows, accountsReady, identityHash, importedAccountRows, markImportedAccount, retryImportedAccount, settleImportedAccountSignIn, transferLimitsReader,
  unavailableAccountId, verifyImportedAccount, verifyImportedAccounts, type IdentityReader, type ImportedAccountRow, type LimitsEvidence, type TransferEngine,
} from "./accounts";
import { decodeBundle, encodeBundle } from "./bundle";
import { exportTransferBundle } from "./exporter";
import { applyTransferImport, previewTransferImport, readImportRecords, recoverTransferImports } from "./importer";
import { installVariables, makeInstall, NOW, REPOSITORY, within, type Install } from "./transfer.fixture";
import type { TransferWorkerResponse } from "./workerProtocol";

/* Accounts (docs/design/install-memory-transfer.md §3, §5.2, operator
   decision Q1): every account the source uses arrives signed out, its
   bindings apply at once, it becomes usable after a sign-in here and a live
   limit read, and the source's active account becomes active only then. No
   credential is read on either side: the sign-ins here are marker files the
   account modules count as signed in, and the provider's identity and limit
   reads are injected, so no engine CLI runs. */

/** A file the account modules read as "signed in". Its bytes are a marker, never a token. */
const MARKER = "fixture-signed-in-marker-never-in-a-bundle";
function signIn(engine: "claude" | "codex", home: string): void {
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(home, engine === "claude" ? ".credentials.json" : "auth.json"), JSON.stringify({ marker: MARKER }), { mode: 0o600 });
}

/** The provider's identity per account label on each install; a test swaps an entry to play a different login. */
const identities = new Map<string, string>([["claude:Main", "main@example.test"], ["claude:Work", "work@example.test"], ["codex:Team", "team@example.test"]]);
/** Per account home: a login that differs from what its label would say; `null` plays a provider read that failed. */
const byHome = new Map<string, string | null>();
let identityReads = 0;
const identity: IdentityReader = async (engine, account) => {
  identityReads += 1;
  if (byHome.has(account.home)) return byHome.get(account.home)!;
  const label = account.kind === "legacy" ? "Main" : (engine === "claude" ? listClaudeAccounts() : listCodexAccounts()).find(candidate => candidate.id === account.id)?.label;
  return identities.get(`${engine}:${label}`) ?? null;
};

const WORKER = path.join(import.meta.dir, "transfer.worker.ts");

/** One transfer step in a real worker process against an install, optionally killed at a named point. */
async function runWorker(install: Install, request: unknown, fault?: string): Promise<{ signal: string | null; response: TransferWorkerResponse | null }> {
  const variables = Object.fromEntries(Object.entries(installVariables(install)).filter((entry): entry is [string, string] => entry[1] !== undefined));
  const env: Record<string, string | undefined> = { ...process.env, ...variables, HOME: install.home, NODE_ENV: "test", LLV_TRANSFER_TEST_FAULT: fault };
  delete env.LLV_SEAT_TICK_SETTINGS_FILE;
  if (!fault) delete env.LLV_TRANSFER_TEST_FAULT;
  const child = Bun.spawn([process.execPath, WORKER], { env: env as Record<string, string>, stdin: "pipe", stdout: "pipe", stderr: "inherit" });
  child.stdin.write(JSON.stringify(request));
  child.stdin.end();
  const [, text] = await Promise.all([child.exited, new Response(child.stdout).text()]);
  const line = text.trim().split("\n").at(-1);
  return { signal: child.signalCode ?? null, response: line ? JSON.parse(line) as TransferWorkerResponse : null };
}

const accountHome = (install: Install, engine: "claude" | "codex", id: string) => path.join(install.config, "delegatus", "accounts", engine, id);

let parent: string;
let source: Install;
let bundle: Buffer;
let sourceIds: { work: string; team: string };

beforeAll(async () => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), "transfer-accounts-"));
  source = makeInstall(parent, "source");
  sourceIds = await within(source, async () => {
    await ensureLegacyCollectionsImported(() => {});
    signIn("claude", path.join(source.home, ".claude"));
    const work = createManagedClaudeAccount("Work");
    signIn("claude", work.home);
    const team = createManagedCodexAccount("Team");
    signIn("codex", team.home);
    createManagedCodexAccount("Idle");
    expect(bindAccountToProject("codex", team.id, REPOSITORY).ok).toBe(true);
    expect(bindAccountToProject("claude", work.id, REPOSITORY).ok).toBe(true);
    setActiveCodexAccount(team.id);
    return { work: work.id, team: team.id };
  });
  bundle = (await within(source, () => exportTransferBundle({ now: new Date(NOW), exportId: "export-accounts", product: "test", env: {}, sections: ["accounts"], accounts: accountExporter("export-accounts", { identity }) }))).bytes;
}, 120_000);

afterAll(() => { fs.rmSync(parent, { recursive: true, force: true }); });

async function target(name: string): Promise<Install> {
  const install = makeInstall(parent, name);
  await within(install, () => ensureLegacyCollectionsImported(() => {}));
  return install;
}

/** The verification's clock, and a live read it takes: fresh, with a plan and windows. */
const CHECK_AT = new Date("2026-10-23T12:00:00.000Z");
const checkClock = () => CHECK_AT;
const evidence = (over: Partial<LimitsEvidence> = {}): LimitsEvidence => ({ authenticated: true, source: "live", staleSince: null, observedAt: CHECK_AT.toISOString(), plan: "pro", windows: true, ...over });
const limitsRead = async () => ({ ok: true as const, evidence: evidence() });

describe("accounts in the bundle", () => {
  test("carry the accounts in use with an identity hash and their bindings, and no credential", async () => {
    const decoded = await decodeBundle(bundle);
    expect(decoded.header.accounts.map(account => [account.engine, account.id, account.kind, account.active])).toEqual([
      ["claude", "default", "legacy", true], ["claude", sourceIds.work, "managed", false], ["codex", sourceIds.team, "managed", true],
    ]);
    expect(decoded.header.accounts.every(account => /^[0-9a-f]{64}$/.test(account.identity ?? ""))).toBe(true);
    const plain = zlib.gunzipSync(bundle).toString("utf8");
    expect(plain).not.toContain(MARKER);
    expect(plain).not.toContain("@example.test");
    expect(decoded.records.filter(record => record.k.startsWith("accounts|binding:")).map(record => record.k).sort()).toEqual([
      `accounts|binding:claude:${sourceIds.work}:${REPOSITORY}`, `accounts|binding:codex:${sourceIds.team}:${REPOSITORY}`,
    ]);
  });
});

describe("accounts on the new install", () => {
  test("arrive signed out with their bindings applied at once; the target keeps its active account until one is usable", async () => {
    const here = await target("target");
    const plan = await within(here, () => previewTransferImport(bundle, {}, { accounts: { identity } }));
    expect(plan.accounts.map(account => [account.engine, account.sourceId, account.action])).toEqual([
      ["claude", "default", "legacy"], ["claude", sourceIds.work, "create"], ["codex", sourceIds.team, "create"],
    ]);
    const section = plan.sections.find(candidate => candidate.name === "accounts")!;
    expect(section.new + section.same + section.conflict + section.skipped).toBe(section.records);
    expect(plan.redo.find(item => item.code === "account_sign_in")?.count).toBe(3);

    const { report } = await within(here, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions }, { accounts: { identity } }));
    expect(report.accounts.map(row => [row.engine, row.sourceId, row.state])).toEqual([
      ["claude", "default", "signed_out"], ["claude", sourceIds.work, "signed_out"], ["codex", sourceIds.team, "signed_out"],
    ]);
    const after = await within(here, () => ({
      claude: listClaudeAccounts().map(account => [account.id, account.label, account.authPresent]),
      codex: listCodexAccounts().map(account => [account.id, account.label, account.authPresent]),
      bindings: accountProjectBindings().map(binding => [binding.engine, binding.accountId, binding.project]),
      allowedCodex: allowedAccountIdsForProject(REPOSITORY, "codex"),
      activeCodex: activeCodexAccountId(),
      rows: importedAccountRows(),
    }));
    const teamHere = after.rows.find(row => row.sourceId === sourceIds.team)!.targetId!;
    const workHere = after.rows.find(row => row.sourceId === sourceIds.work)!.targetId!;
    expect(after.claude).toEqual([["default", "Main", false], [workHere, "Work", false]]);
    expect(after.codex).toEqual([["default", "Main", false], [teamHere, "Team", false]]);
    // The binding is what keeps a project's work off every other account: it is there before any sign-in.
    expect(after.bindings).toEqual(expect.arrayContaining([["codex", teamHere, REPOSITORY], ["claude", workHere, REPOSITORY]]));
    expect([...(after.allowedCodex ?? [])]).toEqual([teamHere]);
    expect(after.activeCodex).toBe("default");

    // Signing in and a live limit read make the account usable, and the source's active one active.
    const selected: [TransferEngine, string][] = [];
    const deps = { identity, readLimits: limitsRead, now: checkClock, select: async (engine: TransferEngine, id: string) => { selected.push([engine, id]); } };
    await within(here, () => signIn("codex", path.join(here.config, "delegatus", "accounts", "codex", teamHere)));
    const team = await within(here, () => verifyImportedAccounts({ engine: "codex" }, deps));
    expect(team.map(row => row.state)).toEqual(["usable"]);
    expect(selected).toEqual([["codex", teamHere]]);

    // A different login on the same account is held back until the operator confirms it.
    identities.set("claude:Work", "someone-else@example.test");
    await within(here, () => signIn("claude", path.join(here.config, "delegatus", "accounts", "claude", workHere)));
    const different = await within(here, () => verifyImportedAccounts({ engine: "claude", sourceId: sourceIds.work }, deps));
    expect(different.map(row => row.state)).toEqual(["different_account"]);
    await within(here, () => markImportedAccount("claude", sourceIds.work, "confirm_identity"));
    expect((await within(here, () => verifyImportedAccounts({ engine: "claude", sourceId: sourceIds.work }, deps))).map(row => row.state)).toEqual(["usable"]);
    identities.set("claude:Work", "work@example.test");

    // A failed read names its cause; «not needed here» settles the row.
    await within(here, () => signIn("claude", path.join(here.home, ".claude")));
    const failed = await within(here, () => verifyImportedAccounts({ engine: "claude", sourceId: "default" }, { ...deps, readLimits: async () => ({ ok: false as const, detail: "quota-probe-timeout" }) }));
    expect(failed.map(row => [row.state, row.detail])).toEqual([["read_failed", "quota-probe-timeout"]]);
    expect(selected).toEqual([["codex", teamHere]]);
    await within(here, () => markImportedAccount("claude", "default", "not_needed"));
    expect((await within(here, () => importedAccountRows())).map(row => row.state).sort()).toEqual(["not_needed", "usable", "usable"]);
    expect(await within(here, () => activeClaudeAccountId())).toBe("default");

    // The same bundle again: every account record arrived already, so it plans no account and makes none (§4.8).
    const again = await within(here, () => previewTransferImport(bundle, {}, { accounts: { identity } }));
    expect(again.accounts).toEqual([]);
    expect(again.sections.find(candidate => candidate.name === "accounts")?.skippedReasons).toEqual({ "already-imported": section.records });
    await within(here, () => applyTransferImport({ bundleSha256: again.bundleSha256, revisions: again.revisions }, { accounts: { identity } }));
    expect(await within(here, () => listCodexAccounts().length)).toBe(2);
    // …and keeps what the checks settled.
    expect((await within(here, () => importedAccountRows())).map(row => row.state).sort()).toEqual(["not_needed", "usable", "usable"]);
  }, 120_000);

  test("an account the target's own engine home holds under another login becomes a managed account", async () => {
    const here = await target("legacy-taken");
    await within(here, () => signIn("claude", path.join(here.home, ".claude")));
    identities.set("claude:Main", "someone-here@example.test");
    try {
      const plan = await within(here, () => previewTransferImport(bundle, {}, { accounts: { identity } }));
      expect(plan.accounts[0]?.action).toBe("create");
      await within(here, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions }, { accounts: { identity } }));
      expect(await within(here, () => listClaudeAccounts().map(account => account.label))).toEqual(["Main", "Main", "Work"]);
    } finally { identities.set("claude:Main", "main@example.test"); }
  }, 60_000);

  test("a completed sign-in settles its row at once and makes the source's active account active", async () => {
    const here = await target("sign-in-hook");
    const plan = await within(here, () => previewTransferImport(bundle, {}, { accounts: { identity } }));
    await within(here, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions }, { accounts: { identity } }));
    const teamHere = (await within(here, () => importedAccountRows())).find(row => row.sourceId === sourceIds.team)!.targetId!;
    const selected: string[] = [];
    // The login's own read runs first; this is what the login completion calls next.
    await within(here, () => settleImportedAccountSignIn("codex", teamHere, { identity, readLimits: limitsRead, now: checkClock, select: async (_engine, id) => { selected.push(id); } }));
    expect((await within(here, () => importedAccountRows())).find(row => row.sourceId === sourceIds.team)?.state).toBe("signed_out");
    expect(selected).toEqual([]);
    await within(here, () => signIn("codex", path.join(here.config, "delegatus", "accounts", "codex", teamHere)));
    await within(here, () => settleImportedAccountSignIn("codex", teamHere, { identity, readLimits: limitsRead, now: checkClock, select: async (_engine, id) => { selected.push(id); } }));
    expect((await within(here, () => importedAccountRows())).find(row => row.sourceId === sourceIds.team)?.state).toBe("usable");
    expect(selected).toEqual([teamHere]);
    // An account no import brought is left alone.
    await within(here, () => settleImportedAccountSignIn("codex", "default", { identity, readLimits: limitsRead, now: checkClock, select: async (_engine, id) => { selected.push(id); } }));
    expect(selected).toEqual([teamHere]);
  }, 60_000);

  test("the target's own engine home stands in when it is signed into the same identity, and waits for its check", async () => {
    const here = await target("legacy-same");
    await within(here, () => signIn("claude", path.join(here.home, ".claude")));
    const plan = await within(here, () => previewTransferImport(bundle, {}, { accounts: { identity } }));
    expect(plan.accounts[0]).toMatchObject({ sourceId: "default", action: "legacy", plannedId: "default" });
    const { report } = await within(here, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions }, { accounts: { identity } }));
    expect(report.accounts.find(row => row.sourceId === "default")?.state).toBe("unchecked");
    expect(report.accountsReady).toBe(false);
    expect(await within(here, () => listClaudeAccounts().map(account => account.label))).toEqual(["Main", "Work"]);
  }, 60_000);

  test("an account whose setup fails keeps its reserved id: the commit fenced its project, and recovery makes exactly that account", async () => {
    const here = await target("resume");
    const plan = await within(here, () => previewTransferImport(bundle, {}, { accounts: { identity } }));
    let refused = 0;
    const { report } = await within(here, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions },
      { accounts: { identity, create: async (engine, label, id) => {
        if (engine === "codex") { refused += 1; throw Object.assign(new Error("setup stopped"), { name: "SetupStoppedError" }); }
        return engine === "claude" ? createManagedClaudeAccount(label, undefined, { id }).id : id;
      } } }));
    expect(refused).toBe(1);
    const team = report.accounts.find(row => row.sourceId === sourceIds.team)!;
    expect([team.state, team.detail, team.retry]).toEqual(["not_created", "SetupStoppedError", true]);
    const reserved = team.targetId!;
    // Bound to the reserved id before the account exists: the project parks instead of widening.
    const fenced = await within(here, () => ({
      allowed: allowedAccountIdsForProject(REPOSITORY, "codex"), codex: listCodexAccounts().map(account => account.id), home: fs.existsSync(accountHome(here, "codex", reserved)),
    }));
    expect(fenced).toEqual({ allowed: [reserved], codex: ["default"], home: true });
    expect(report.accountsReady).toBe(false);
    // Recovery (no manual step: the Viewer runs it after a failed apply and at start) makes it once, under that id.
    await within(here, () => recoverTransferImports({ identity }));
    await within(here, () => recoverTransferImports({ identity }));
    expect(await within(here, () => retryImportedAccount("codex", sourceIds.team))).toMatchObject({ state: "signed_out", targetId: reserved });
    const after = await within(here, () => ({ codex: listCodexAccounts().map(account => account.id), allowed: allowedAccountIdsForProject(REPOSITORY, "codex"), row: importedAccountRows().find(row => row.sourceId === sourceIds.team) }));
    expect(after.codex).toEqual(["default", reserved]);
    expect(after.allowed).toEqual([reserved]);
    expect([after.row?.state, after.row?.pendingCreate]).toEqual(["signed_out", undefined]);
  }, 60_000);

  test("a setup stopped after its registry write, or with its home made and no registry row, ends as exactly one account", async () => {
    for (const stop of ["after-registry", "mid-home"] as const) {
      const here = await target(`partial-${stop}`);
      const plan = await within(here, () => previewTransferImport(bundle, {}, { accounts: { identity } }));
      const { report } = await within(here, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions }, { accounts: { identity, create: async (engine, label, id) => {
        if (engine !== "codex") return createManagedClaudeAccount(label, undefined, { id }).id;
        createManagedCodexAccount(label, { id });
        if (stop === "mid-home") {
          /* What a stop between the home's setup and its registry row leaves: the home made, no row. */
          const read = readAccountSource(CODEX_ACCOUNTS_SOURCE);
          const body = (read.kind === "collection" ? read.body : null) as { accounts: { id: string }[] } | null;
          writeAccountSource(CODEX_ACCOUNTS_SOURCE, { ...body, accounts: body!.accounts.filter(account => account.id !== id) });
          expect(fs.readdirSync(accountHome(here, "codex", id)).length).toBeGreaterThan(0);
        }
        throw new Error("stopped");
      } } }));
      const reserved = report.accounts.find(row => row.sourceId === sourceIds.team)!.targetId!;
      for (let attempt = 0; attempt < 2; attempt += 1) await within(here, () => recoverTransferImports({ identity }));
      await within(here, () => retryImportedAccount("codex", sourceIds.team));
      const after = await within(here, () => ({ codex: listCodexAccounts().map(account => account.id), row: importedAccountRows().find(row => row.sourceId === sourceIds.team) }));
      expect(after.codex).toEqual(["default", reserved]);
      expect(after.row?.state).toBe("signed_out");
    }
  }, 120_000);

  test("a same-id account here signed into another login is never reused or bound", async () => {
    const here = await target("same-id");
    const local = await within(here, () => { const made = createManagedClaudeAccount("Work"); signIn("claude", made.home); return made; });
    expect(local.id).toBe(sourceIds.work);
    byHome.set(local.home, "someone-here@example.test");
    identityReads = 0;
    try {
      const plan = await within(here, () => previewTransferImport(bundle, {}, { accounts: { identity } }));
      expect(plan.accounts.find(account => account.sourceId === sourceIds.work)?.action).toBe("create");
      expect(identityReads).toBeGreaterThan(0);
      const { report } = await within(here, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions }, { accounts: { identity } }));
      const workHere = report.accounts.find(row => row.sourceId === sourceIds.work)!.targetId!;
      expect(workHere).not.toBe(local.id);
      expect(await within(here, () => allowedAccountIdsForProject(REPOSITORY, "claude"))).toEqual([workHere]);
    } finally { byHome.delete(local.home); }
  }, 60_000);

  test("a skipped provider account's bindings authorize no account here, even one with its id", async () => {
    const here = await target("provider-collision");
    await within(here, () => { const made = createManagedClaudeAccount("Work"); signIn("claude", made.home); });
    const provider = encodeBundle({ exportId: "provider", createdAt: NOW, product: "test", projects: [], accounts: [], environment: [], notices: [], sections: [
      { name: "accounts", schema: 1, summary: {}, records: [
        { k: "accounts|account:claude:work", v: { engine: "claude", id: "work", label: "Gateway", kind: "managed", active: false, identity: null, provider: { baseUrl: "https://gateway.example.test", model: "m" } } },
        { k: `accounts|binding:claude:work:${REPOSITORY}`, v: { engine: "claude", accountId: "work", project: REPOSITORY } },
      ] },
    ] });
    const plan = await within(here, () => previewTransferImport(provider, {}, { accounts: { identity } }));
    expect(plan.accounts.map(account => [account.action, account.reason])).toEqual([["skip", "provider-account"]]);
    await within(here, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions }, { accounts: { identity } }));
    expect(await within(here, () => allowedAccountIdsForProject(REPOSITORY, "claude"))).toEqual([unavailableAccountId("work")]);
    // «Not needed here» settles a row that could not be made.
    const rows = await within(here, () => accountReportRows());
    expect(rows.map(row => [row.state, row.detail, row.retry])).toEqual([["not_created", "provider-account", undefined]]);
    expect(accountsReady(rows)).toBe(false);
    await within(here, () => markImportedAccount("claude", "work", "not_needed"));
    expect(accountsReady(await within(here, () => accountReportRows()))).toBe(true);
  }, 60_000);

  test("an identity this install cannot read keeps the row waiting and makes nothing active", async () => {
    const here = await target("identity-unread");
    const plan = await within(here, () => previewTransferImport(bundle, {}, { accounts: { identity } }));
    const { report } = await within(here, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions }, { accounts: { identity } }));
    const teamHere = report.accounts.find(row => row.sourceId === sourceIds.team)!.targetId!;
    const home = accountHome(here, "codex", teamHere);
    await within(here, () => signIn("codex", home));
    byHome.set(home, null);
    const selected: string[] = [];
    const deps = { identity, readLimits: limitsRead, now: checkClock, select: async (_engine: TransferEngine, id: string) => { selected.push(id); } };
    try {
      const waiting = await within(here, () => verifyImportedAccounts({ engine: "codex" }, deps));
      expect(waiting.map(row => [row.state, row.detail])).toEqual([["read_failed", "identity-unreadable"]]);
      expect(selected).toEqual([]);
      expect(await within(here, () => activeCodexAccountId())).toBe("default");
      // The operator's confirmation is the evidence the read could not give.
      await within(here, () => markImportedAccount("codex", sourceIds.team, "confirm_identity"));
      expect((await within(here, () => verifyImportedAccounts({ engine: "codex" }, deps))).map(row => row.state)).toEqual(["usable"]);
      expect(selected).toEqual([teamHere]);
    } finally { byHome.delete(home); }
  }, 60_000);

  test("a worker killed after its reservations gives them back; one killed after its commit is finished by recovery", async () => {
    const reservedHere = await target("killed-reserved");
    const reservedPlan = await within(reservedHere, () => previewTransferImport(bundle, {}, { accounts: { identity } }));
    const killed = await runWorker(reservedHere, { operation: "apply", request: { bundleSha256: reservedPlan.bundleSha256, revisions: reservedPlan.revisions } }, "die-after-reservations");
    expect(killed.signal).toBe("SIGKILL");
    const homes = () => ["claude", "codex"].flatMap(engine => {
      const root = path.join(reservedHere.config, "delegatus", "accounts", engine);
      return fs.existsSync(root) ? fs.readdirSync(root).filter(name => /^[a-z0-9-]+$/.test(name)).map(name => `${engine}/${name}`) : [];
    });
    expect(homes().length).toBe(2);
    expect((await runWorker(reservedHere, { operation: "recover" })).response).toMatchObject({ ok: true, result: [{ outcome: "rolled-back" }] });
    expect(homes()).toEqual([]);
    expect(await within(reservedHere, () => ({ bindings: accountProjectBindings(), rows: importedAccountRows(), records: readImportRecords() }))).toEqual({ bindings: [], rows: [], records: [] });

    const committedHere = await target("killed-committed");
    const committedPlan = await within(committedHere, () => previewTransferImport(bundle, {}, { accounts: { identity } }));
    expect((await runWorker(committedHere, { operation: "apply", request: { bundleSha256: committedPlan.bundleSha256, revisions: committedPlan.revisions } }, "die-after-commit")).signal).toBe("SIGKILL");
    // Committed: every project is already fenced to the reserved ids, before any account exists.
    const fenced = await within(committedHere, () => ({ rows: importedAccountRows(), allowed: allowedAccountIdsForProject(REPOSITORY, "codex"), codex: listCodexAccounts().length }));
    const teamReserved = fenced.rows.find(row => row.sourceId === sourceIds.team)!.targetId!;
    expect([fenced.allowed, fenced.codex]).toEqual([[teamReserved], 1]);
    expect((await runWorker(committedHere, { operation: "recover" })).response).toMatchObject({ ok: true, result: [{ outcome: "finished" }] });
    expect((await runWorker(committedHere, { operation: "recover" })).response).toEqual({ ok: true, result: [] });
    const after = await within(committedHere, () => ({ codex: listCodexAccounts().map(account => account.id), record: readImportRecords()[0], rows: importedAccountRows().map(row => [row.sourceId, row.state]) }));
    expect(after.codex).toEqual(["default", teamReserved]);
    expect(after.record?.followUp).toEqual({ knownValues: false, accounts: false });
    expect(after.rows.sort()).toEqual([["default", "signed_out"], [sourceIds.team, "signed_out"], [sourceIds.work, "signed_out"]].sort());
  }, 120_000);

  test("a forged account record is skipped and makes nothing", async () => {
    const here = await target("forged");
    const forged = encodeBundle({ exportId: "forged", createdAt: NOW, product: "test", projects: [], accounts: [], environment: [], notices: [], sections: [
      { name: "accounts", schema: 1, summary: {}, records: [
        { k: "accounts|account:claude:x", v: { engine: "claude", id: "y", label: "X", kind: "managed", active: true, identity: null } },
        { k: "accounts|account:claude:../../etc", v: { engine: "claude", id: "../../etc", label: "X", kind: "managed", active: false, identity: null } },
      ] },
    ] });
    const plan = await within(here, () => previewTransferImport(forged, {}, { accounts: { identity } }));
    expect(plan.sections[0]).toMatchObject({ skipped: 2, skippedReasons: { "invalid-record": 2 } });
    await within(here, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions }, { accounts: { identity } }));
    expect(await within(here, () => listClaudeAccounts().length)).toBe(1);
  }, 60_000);
});

describe("a later import naming the same source account", () => {
  /** An install where this bundle's Codex account is signed in, checked usable, and confirmed after a different-login answer. */
  async function settledTarget(name: string): Promise<{ here: Install; teamHere: string }> {
    const here = await target(name);
    const plan = await within(here, () => previewTransferImport(bundle, {}, { accounts: { identity } }));
    await within(here, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions }, { accounts: { identity } }));
    const teamHere = (await within(here, () => importedAccountRows())).find(row => row.sourceId === sourceIds.team)!.targetId!;
    await within(here, () => signIn("codex", accountHome(here, "codex", teamHere)));
    await within(here, () => markImportedAccount("codex", sourceIds.team, "confirm_identity"));
    const checked = await within(here, () => verifyImportedAccounts({ engine: "codex" }, { identity, readLimits: limitsRead, now: checkClock, select: async () => {} }));
    expect(checked.map(row => [row.state, row.confirmedDifferent])).toEqual([["usable", true]]);
    return { here, teamHere };
  }

  /** A bundle with one Codex account under the source id this bundle uses, signed into `login`. */
  const codexBundle = (exportId: string, login: string | null) => encodeBundle({ exportId, createdAt: NOW, product: "test", projects: [], accounts: [], environment: [], notices: [], sections: [
    { name: "accounts", schema: 1, summary: {}, records: [
      { k: `accounts|account:codex:${sourceIds.team}`, v: { engine: "codex", id: sourceIds.team, label: "Team", kind: "managed", active: true, identity: identityHash(exportId, login) } },
      { k: `accounts|binding:codex:${sourceIds.team}:${REPOSITORY}`, v: { engine: "codex", accountId: sourceIds.team, project: REPOSITORY } },
    ] },
  ] });

  async function importInto(here: Install, bytes: Buffer) {
    const plan = await within(here, () => previewTransferImport(bytes, {}, { accounts: { identity } }));
    const { report } = await within(here, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions }, { accounts: { identity } }));
    return { plan, report };
  }

  for (const [label, login] of [["another install's account under the same id", "stranger@example.test"], ["the source account signed into another login since", "team-new@example.test"]] as const) {
    test(`${label} gets an account of its own, checked anew; the earlier row keeps its own`, async () => {
      const { here, teamHere } = await settledTarget(`later-${login.split("@")[0]}`);
      const { plan, report } = await importInto(here, codexBundle(`export-${login}`, login));
      const fresh = plan.accounts[0]!;
      expect([fresh.action, fresh.plannedId === teamHere]).toEqual(["create", false]);
      const row = report.accounts.find(entry => entry.targetId !== teamHere)!;
      expect([row.sourceId, row.state]).toEqual([sourceIds.team, "signed_out"]);
      expect(report.accountsReady).toBe(false);
      const rows = await within(here, () => importedAccountRows().filter(entry => entry.sourceId === sourceIds.team));
      // The confirmation was for the earlier login: the new row carries none; the earlier row is still the earlier one's.
      expect(rows.map(entry => [entry.targetId === teamHere, entry.state, entry.confirmedDifferent ?? false]).sort()).toEqual([[false, "signed_out", false], [true, "usable", true]]);
      // Signed into the earlier account's login, the new account is a different account and is not made active.
      const newHere = row.targetId!;
      await within(here, () => signIn("codex", accountHome(here, "codex", newHere)));
      byHome.set(accountHome(here, "codex", newHere), "team@example.test");
      const selected: string[] = [];
      try {
        const checked = await within(here, () => verifyImportedAccounts({ engine: "codex", sourceId: sourceIds.team, targetId: newHere }, { identity, readLimits: limitsRead, now: checkClock, select: async (_engine, id) => { selected.push(id); } }));
        expect(checked.map(entry => entry.state)).toEqual(["different_account"]);
        expect(selected).toEqual([]);
      } finally { byHome.delete(accountHome(here, "codex", newHere)); }
    }, 120_000);
  }

  test("a new export of the same login stands in for the account signed in here, which is read again before it is ready", async () => {
    const { here, teamHere } = await settledTarget("later-same-login");
    const { plan, report } = await importInto(here, codexBundle("export-same-login", "team@example.test"));
    expect([plan.accounts[0]?.action, plan.accounts[0]?.plannedId]).toEqual(["existing", teamHere]);
    expect(report.accounts.map(entry => [entry.targetId, entry.state])).toEqual([[teamHere, "unchecked"]]);
    expect(report.accountsReady).toBe(false);
    const row = (await within(here, () => importedAccountRows())).find(entry => entry.targetId === teamHere)!;
    expect([row.exportId, row.confirmedDifferent]).toEqual(["export-same-login", undefined]);
    expect(await within(here, () => listCodexAccounts().length)).toBe(2);
  }, 120_000);

  test("a replay while the account here is still signed out: the same bundle changes nothing, a new export proves nothing", async () => {
    const here = await target("later-signed-out");
    const first = await importInto(here, codexBundle("export-signed-out", "team@example.test"));
    const teamHere = first.report.accounts[0]!.targetId!;
    const replay = await importInto(here, codexBundle("export-signed-out", "team@example.test"));
    expect(replay.plan.accounts).toEqual([]);
    expect(await within(here, () => importedAccountRows().map(entry => [entry.targetId, entry.state]))).toEqual([[teamHere, "signed_out"]]);
    // Signed out, the account here holds no login to compare: a new export gets its own.
    const later = await importInto(here, codexBundle("export-signed-out-2", "team@example.test"));
    expect(later.plan.accounts[0]?.action).toBe("create");
    expect(later.report.accounts[0]?.targetId).not.toBe(teamHere);
    expect(later.report.accountsReady).toBe(false);
  }, 120_000);
});

describe("the transfer-verify read through the production adapter", () => {
  /** One Claude account here, signed in, the source's active one; its identity is not checked (none travelled). */
  const ROW: ImportedAccountRow = {
    kind: "account", importId: "import-verify", exportId: "export-verify", engine: "claude", sourceId: "work", targetId: "work-here", label: "Work",
    sourceKind: "managed", activeOnSource: true, identity: null, bindings: [], state: "signed_out",
  };
  const window = { usedPercent: 10, resetsAt: Math.floor(CHECK_AT.getTime() / 1000) + 3_600, windowMinutes: 300 };
  const observation = (over: Record<string, unknown> = {}) => ({
    engine: "claude", accountId: "work-here", authenticated: true, observedAt: CHECK_AT.getTime(),
    limits: { session: window, weekly: window, plan: "max", capturedAt: Math.floor(CHECK_AT.getTime() / 1000) },
    provenance: { source: "live", reason: null, staleSince: null }, ...over,
  });

  let installs = 0;
  async function verifyWith(observed: Record<string, unknown>): Promise<{ row: ImportedAccountRow; selected: string[] }> {
    installs += 1;
    const here = await target(`adapter-${installs}`);
    const home = path.join(here.root, "work-home");
    const account = { id: "work-here", label: "Work", kind: "managed" as const, home, signedIn: true };
    const probe = { list: () => [account], active: () => "default", probe: async () => observed } as never;
    const registry = { recordQuotaObservation: () => {}, quotaObservations: () => [] } as never;
    const selected: string[] = [];
    const row = await within(here, () => verifyImportedAccount(ROW, {
      list: async () => [account], identity, now: checkClock, readLimits: transferLimitsReader({ probe, registry, now: CHECK_AT.getTime() }),
      select: async (_engine, id) => { selected.push(id); },
    }));
    return { row, selected };
  }

  test("a fresh live read with a plan and windows makes the account usable and active", async () => {
    const { row, selected } = await verifyWith(observation());
    expect([row.state, selected]).toEqual(["usable", ["work-here"]]);
  }, 60_000);

  for (const [name, observed, detail] of [
    ["a read the provider refused, answered from cache", observation({ provenance: { source: "cache", reason: "quota-probe-failed", staleSince: "2026-10-23T11:00:00.000Z" }, observedAt: CHECK_AT.getTime() - 3_600_000 }), "limits-not-live"],
    ["a live read that names no plan", observation({ limits: { session: window, weekly: window, plan: null, capturedAt: null } }), "no-plan"],
    ["a live read taken long before this check", observation({ observedAt: CHECK_AT.getTime() - 3_600_000 }), "limits-stale"],
  ] as const) {
    test(`${name} stays read_failed and switches no active account`, async () => {
      const { row, selected } = await verifyWith(observed);
      expect([row.state, row.detail, selected]).toEqual(["read_failed", detail, []]);
    }, 60_000);
  }
});
