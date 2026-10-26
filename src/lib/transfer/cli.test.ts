import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import { internalServiceHeaders } from "@/lib/agent/callerClaims";
import { ensureOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { soloBrowserSession } from "@/lib/agent/operatorSession";
import { leaveSeatLessons, roleMemoryCollection } from "@/lib/memory/roleStore";
import { ensureLegacyCollectionsImported } from "@/lib/state/legacyCollections";

import { runTransferCommand } from "../../../bin/transfer.mjs";
import { readImportRecords } from "./importer";
import { getAccounts, getReport, postAccounts, postApply, postExport, postPreview, transferGate } from "./routes";
import { makeInstall, REPOSITORY, seedSource, within, type Install } from "./transfer.fixture";

/* `delegatus export` and `delegatus import` (install-memory-transfer §4.2)
   against the real routes, service and worker, served from this process on
   an ephemeral loopback port, between two isolated installs. */

let parent: string;
let source: Install;
let target: Install;
let folderKey: string;
let ruleIds: string[];
let server: ReturnType<typeof Bun.serve>;

async function closedPort(): Promise<number> {
  const probe = net.createServer();
  await new Promise<void>(resolve => probe.listen(0, "127.0.0.1", resolve));
  const port = (probe.address() as net.AddressInfo).port;
  await new Promise<void>(resolve => probe.close(() => resolve()));
  return port;
}

function cli(install: Install, command: "export" | "import", args: string[], extra: Partial<Parameters<typeof runTransferCommand>[2]> = {}) {
  const lines: string[] = [];
  const errors: string[] = [];
  const run = within(install, () => runTransferCommand(command, args, {
    stateDirectory: install.state,
    env: { LLV_VIEWER_CONTROL_URL: `http://127.0.0.1:${server.port}`, LLV_LANG: "en" },
    log: line => lines.push(line), err: line => errors.push(line),
    terminal: () => null, passphrase: () => "AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF", now: () => new Date("2026-10-22T12:00:00Z"),
    ...extra,
  }));
  return run.then(code => ({ code, out: lines.join("\n"), err: errors.join("\n") }));
}

beforeAll(async () => {
  parent = fs.mkdtempSync(path.join(os.tmpdir(), "transfer-cli-"));
  source = makeInstall(parent, "source");
  target = makeInstall(parent, "target");
  ({ folderKey, ruleIds } = await seedSource(source));
  fs.mkdirSync(path.join(target.root, "work", "beta"), { recursive: true });
  for (const install of [source, target]) await within(install, async () => { await ensureLegacyCollectionsImported(() => {}); ensureOperatorSpawnCapability(); });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const req = new NextRequest(request);
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/transfer/export") return postExport(req);
    if (pathname === "/api/transfer/preview") return postPreview(req);
    if (pathname === "/api/transfer/apply") return postApply(req);
    if (pathname === "/api/transfer/report") return getReport(req);
    if (pathname === "/api/transfer/accounts") return request.method === "POST" ? postAccounts(req) : getAccounts(req);
    return new Response("not found", { status: 404 });
  } });
}, 120_000);

afterAll(async () => {
  await server?.stop(true);
  fs.rmSync(parent, { recursive: true, force: true });
});

describe("delegatus export / import", () => {
  test("refuses without a running Viewer, for both commands, and writes nothing", async () => {
    const port = await closedPort();
    const bundle = path.join(parent, "nothing.dlgt");
    fs.writeFileSync(bundle, "not a bundle");
    const before = fs.readdirSync(target.state).sort();
    const env = { LLV_VIEWER_CONTROL_URL: `http://127.0.0.1:${port}`, LLV_LANG: "en" };
    const errors: string[] = [];
    expect(await runTransferCommand("import", [bundle], { stateDirectory: target.state, env, err: line => errors.push(line), log: () => {} })).toBe(3);
    expect(await runTransferCommand("export", [], { stateDirectory: target.state, env, err: line => errors.push(line), log: () => {} })).toBe(3);
    expect(errors).toEqual(["Delegatus is not running here. Start Delegatus, then import.", "Delegatus is not running here. Start Delegatus, then export."]);
    expect(fs.readdirSync(target.state).sort()).toEqual(before);
  });

  test("refuses a Viewer address that is not loopback", async () => {
    const errors: string[] = [];
    const code = await runTransferCommand("export", [], { stateDirectory: target.state, env: { LLV_VIEWER_CONTROL_URL: "http://example.test:8898" },
      err: line => errors.push(line), log: () => {}, resolve: async () => [{ address: "203.0.113.5" }] });
    expect(code).toBe(2);
    expect(errors[0]).toContain("loopback");
  });

  test("exports sealed, dry-runs, applies with a folder mapping and reports", async () => {
    const file = path.join(parent, "bundle.dlgt");
    const exported = await cli(source, "export", ["--out", file]);
    expect(exported.code).toBe(0);
    expect(exported.err).toContain("Passphrase (shown once, not stored anywhere): AAAAA-BBBBB-CCCCC-DDDDD-EEEEE-FFFFF");
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(file).subarray(0, 40).toString()).toStartWith('{"format":"delegatus-transfer-sealed"');

    const passphrase = path.join(parent, "passphrase.txt");
    fs.writeFileSync(passphrase, "aaaaa-bbbbb-ccccc-ddddd-eeeee-fffff\n");
    const wrong = path.join(parent, "wrong.txt");
    fs.writeFileSync(wrong, "AAAAA-AAAAA-AAAAA-AAAAA-AAAAA-AAAAA\n");
    expect((await cli(target, "import", [file, "--passphrase-file", wrong, "--dry-run"])).code).toBe(2);

    const dry = await cli(target, "import", [file, "--passphrase-file", passphrase, "--dry-run"]);
    expect(dry.code).toBe(0);
    expect(dry.out).toContain("memory.role");
    expect(dry.out).toContain("Folders not mapped");
    expect(await within(target, () => readImportRecords())).toEqual([]);

    const map = `${folderKey}=${path.join(target.root, "work", "beta")}`;
    const applied = await cli(target, "import", [file, "--passphrase-file", passphrase, "--map", map, "--yes"]);
    expect(applied.err).toBe("");
    expect(applied.code).toBe(0);
    expect(applied.out).toContain("Applied in");
    expect(applied.out).not.toContain("Folders not mapped");
    const records = await within(target, () => readImportRecords());
    expect(records).toHaveLength(1);
    expect(JSON.parse(fs.readFileSync(path.join(target.state, "project-settings.json"), "utf8")).projects[REPOSITORY].mergeOnReview.enabled).toBe(true);

    const report = await cli(target, "import", ["--report"]);
    expect(report.code).toBe(0);
    expect(report.out).toContain("✓ memory.role");
    // §5.1: each record that did not arrive is named with its reason.
    expect(report.out).toMatch(/ {6}skipped settings\.relay\|\S+: waits for the relay pairing/);
  }, 180_000);

  test("a dry run into a populated install shows both texts of a conflicting rule and what apply would do, and applies nothing", async () => {
    const changed = makeInstall(parent, "source-changed");
    fs.cpSync(source.root, changed.root, { recursive: true });
    await within(changed, () => leaveSeatLessons({ source: { origin: "seat", project: REPOSITORY, roleId: "orchestrator", fixRound: false, conversationId: "c-cli" }, now: "2026-10-24T00:00:00.000Z",
      lessons: [], rewrite: { id: ruleIds[2]!, rule: "Read the newest answer before every action.", why: "Later answers replace earlier ones." } }));
    const file = path.join(parent, "changed.dlgt");
    expect((await cli(changed, "export", ["--plain", "--out", file])).code).toBe(0);
    const records = await within(target, () => readImportRecords());
    const dry = await cli(target, "import", [file, "--dry-run"]);
    expect(dry.code).toBe(0);
    const lines = dry.out.split("\n");
    const at = lines.findIndex(line => line === `      conflict rows:role_memory|r:${ruleIds[2]}: the bundle's text is kept as a version of this install's rule`);
    expect(at).toBeGreaterThan(-1);
    expect(lines.slice(at + 1, at + 5)).toEqual([
      expect.stringMatching(/^ {8}from the bundle \(rule, a seat, active, changed 2026-10-24T00:00:00\.000Z\)$/),
      "          Read the newest answer before every action.",
      expect.stringMatching(/^ {8}on this install \(rule, a seat, active, changed \S+\)$/),
      "          Read the newest operator answer before acting.",
    ]);
    expect(await within(target, () => readImportRecords())).toEqual(records);
    expect(await within(target, () => roleMemoryCollection()!.get(`r:${ruleIds[2]}`))).toMatchObject({ rule: "Read the newest operator answer before acting." });
  }, 180_000);

  test("a dry run shows each setting's two values, the planned accounts and the scopes over budget, in each language", async () => {
    const plan = {
      bundleSha256: "0".repeat(64), exportId: "e", createdAt: "2026-10-22T00:00:00.000Z", sourceProduct: "test", unknownSections: [], projects: [], redo: [], environment: [], notices: [], revisions: {}, previousImport: null,
      sections: [{
        name: "settings.projects", records: 2, new: 0, same: 0, conflict: 1, skipped: 1, pending: 0, replace: false,
        skippedReasons: { "target-file-unreadable": 1 }, skippedRecords: [{ key: "settings.projects|map:project-settings|repo-b", reason: "target-file-unreadable" }],
        conflicts: [{ key: "map:project-settings|repo-a", action: "kept-target",
          source: { kind: "object", at: "2026-10-20T00:00:00.000Z", value: { mergeOnReview: { enabled: true } } },
          target: { kind: "object", at: null, value: { mergeOnReview: { enabled: false } } } }],
      }],
      accounts: [
        { engine: "codex", sourceId: "team", label: "Team", kind: "managed", sourceActive: true, action: "create", plannedId: null, bindings: ["repo-a"] },
        { engine: "claude", sourceId: "work", label: "Work", kind: "managed", sourceActive: false, action: "existing", plannedId: "work-2", bindings: [] },
        { engine: "claude", sourceId: "provider", label: "Gateway", kind: "managed", sourceActive: false, action: "skip", plannedId: null, bindings: [], reason: "provider-account" },
      ],
      overBudgetScopes: [{ scope: "project:repo-a", codePoints: 12_345 }],
    };
    const stub = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: request => new URL(request.url).pathname === "/api/transfer/preview"
      ? Response.json({ ok: true, result: plan }) : new Response("not found", { status: 404 }) });
    const file = path.join(parent, "stub.dlgt");
    fs.writeFileSync(file, "a plain bundle the stub never reads");
    try {
      const run = async (lang: "en" | "uk") => {
        const lines: string[] = [];
        const code = await runTransferCommand("import", [file, "--dry-run"], { stateDirectory: target.state, env: { LLV_VIEWER_CONTROL_URL: `http://127.0.0.1:${stub.port}`, LLV_LANG: lang },
          log: line => lines.push(line), err: line => lines.push(line), terminal: () => null });
        expect(code).toBe(0);
        return lines;
      };
      expect(await run("en")).toEqual([
        "  settings.projects       2 records: 0 new, 0 same, 1 conflict, 1 skipped",
        "      skipped settings.projects|map:project-settings|repo-b: this install's file is damaged or not a regular file; repair it, then import again",
        "      conflict map:project-settings|repo-a: this install keeps its own",
        "        from the bundle (object, changed 2026-10-20T00:00:00.000Z)",
        "          {\"mergeOnReview\":{\"enabled\":true}}",
        "        on this install (object)",
        "          {\"mergeOnReview\":{\"enabled\":false}}",
        "Accounts:",
        "  codex «Team»: made here signed out; bound to repo-a (active on the source)",
        "  claude «Work»: already here as work-2",
        "  claude «Gateway»: not made here (a provider account needs its token here)",
        "Over the 10 000 code point target after the merge: project:repo-a (12345); the next curation trims it.",
      ]);
      const uk = await run("uk");
      expect(uk).toContain("      конфлікт map:project-settings|repo-a: ця інсталяція лишає своє");
      expect(uk).toContain("  codex «Team»: буде створений тут без входу; прив'язаний до repo-a (активний на джерелі)");
      expect(uk).toContain("Понад ціль 10 000 символів після злиття: project:repo-a (12345); наступне курування скоротить.");
    } finally { await stub.stop(true); }
  });

  test("pipes a plain bundle from export into import", async () => {
    const piped: Buffer[] = [];
    const exported = await cli(source, "export", ["--plain", "-"], { writeStdout: bytes => piped.push(bytes) });
    expect(exported.code).toBe(0);
    expect(exported.err).not.toContain("Passphrase");
    const second = makeInstall(parent, "piped-target");
    await within(second, async () => { await ensureLegacyCollectionsImported(() => {}); ensureOperatorSpawnCapability(); });
    const imported = await cli(second, "import", ["-", "--yes"], { readStdin: async () => Buffer.concat(piped) });
    expect(imported.code).toBe(0);
    expect(imported.out).toContain("Folders not mapped");
  }, 180_000);
});

describe("transfer route gate", () => {
  const PAGE = { host: "127.0.0.1:8898", origin: "http://127.0.0.1:8898", "sec-fetch-site": "same-origin" };
  const gate = (headers: Record<string, string>) => within(target, () => transferGate(new NextRequest("http://127.0.0.1:8898/api/transfer/report", { headers })));

  test("admits the owner's page and the host controller, refuses agents, other services and other sites", async () => {
    /* The owner's page holds the session cookie its navigation opened; Fetch Metadata alone proves nothing. */
    const page = { ...PAGE, cookie: `llv_operator=${await within(target, () => soloBrowserSession())}` };
    expect(await gate(page)).toBeNull();
    expect(await gate({ host: "127.0.0.1:8898", ...await within(target, () => internalServiceHeaders("controller")) })).toBeNull();
    for (const headers of <Record<string, string>[]>[
      { host: "127.0.0.1:8898", ...await within(target, () => internalServiceHeaders("mcp")) },
      PAGE,
      { ...page, "x-llv-spawn-capability": "A".repeat(43) },
      { host: "127.0.0.1:8898", origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" },
      { host: "127.0.0.1:8898" },
      { host: "127.0.0.1:8898", "x-llv-internal-service": `controller.${"0".repeat(64)}` },
    ]) {
      const refused = await gate(headers);
      expect(refused?.status).toBe(403);
    }
  });
});
