import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import { activeClaudeAccountId, createManagedClaudeAccount, listClaudeAccounts } from "@/lib/accounts/claude";
import { activeCodexAccountId, createManagedCodexAccount, listCodexAccounts, setActiveCodexAccount } from "@/lib/accounts/codex";
import { accountProjectBindings, allowedAccountIdsForProject, bindAccountToProject } from "@/lib/accounts/projectBindings";
import { ensureLegacyCollectionsImported } from "@/lib/state/legacyCollections";

import { accountExporter, importedAccountRows, markImportedAccount, settleImportedAccountSignIn, verifyImportedAccounts, type IdentityReader, type TransferEngine } from "./accounts";
import { decodeBundle, encodeBundle } from "./bundle";
import { exportTransferBundle } from "./exporter";
import { applyTransferImport, previewTransferImport, readImportRecords, recoverTransferImports } from "./importer";
import { makeInstall, NOW, REPOSITORY, within, type Install } from "./transfer.fixture";

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
const identity: IdentityReader = async (engine, account) => {
  const label = account.kind === "legacy" ? "Main" : (engine === "claude" ? listClaudeAccounts() : listCodexAccounts()).find(candidate => candidate.id === account.id)?.label;
  return identities.get(`${engine}:${label}`) ?? null;
};

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

const limitsRead = async () => ({ ok: true as const, windows: true, authenticated: true });

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
    const deps = { identity, readLimits: limitsRead, select: async (engine: TransferEngine, id: string) => { selected.push([engine, id]); } };
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

    // The same bundle again makes no second account.
    const again = await within(here, () => previewTransferImport(bundle, {}, { accounts: { identity } }));
    expect(again.accounts.map(account => account.action)).toEqual(["existing", "existing", "existing"]);
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
    await within(here, () => settleImportedAccountSignIn("codex", teamHere, { identity, readLimits: limitsRead, select: async (_engine, id) => { selected.push(id); } }));
    expect((await within(here, () => importedAccountRows())).find(row => row.sourceId === sourceIds.team)?.state).toBe("signed_out");
    expect(selected).toEqual([]);
    await within(here, () => signIn("codex", path.join(here.config, "delegatus", "accounts", "codex", teamHere)));
    await within(here, () => settleImportedAccountSignIn("codex", teamHere, { identity, readLimits: limitsRead, select: async (_engine, id) => { selected.push(id); } }));
    expect((await within(here, () => importedAccountRows())).find(row => row.sourceId === sourceIds.team)?.state).toBe("usable");
    expect(selected).toEqual([teamHere]);
    // An account no import brought is left alone.
    await within(here, () => settleImportedAccountSignIn("codex", "default", { identity, readLimits: limitsRead, select: async (_engine, id) => { selected.push(id); } }));
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

  test("accounts interrupted after the commit are made by recovery from the import record", async () => {
    const here = await target("resume");
    const plan = await within(here, () => previewTransferImport(bundle, {}, { accounts: { identity } }));
    const failure = await within(here, () => applyTransferImport({ bundleSha256: plan.bundleSha256, revisions: plan.revisions },
      { accounts: { identity, bind: async () => { throw new Error("stopped before the bindings"); } } })).then(() => null, (error: unknown) => error);
    expect(String(failure)).toContain("stopped before the bindings");
    expect((await within(here, () => readImportRecords()))[0]?.accountsApplied).toBe(false);
    await within(here, () => recoverTransferImports({ identity }));
    const after = await within(here, () => ({ record: readImportRecords()[0], codex: listCodexAccounts().length, bindings: accountProjectBindings().length }));
    expect(after.record?.accountsApplied).toBe(true);
    expect(after.codex).toBe(2);
    expect(after.bindings).toBe(2);
  }, 60_000);

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
