import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import { internalServiceHeaders } from "@/lib/agent/callerClaims";
import { ensureOperatorSpawnCapability } from "@/lib/agent/operatorCapability";
import { ensureLegacyCollectionsImported } from "@/lib/state/legacyCollections";

import { runTransferCommand } from "../../../bin/transfer.mjs";
import { readImportRecords } from "./importer";
import { getReport, postApply, postExport, postPreview, transferGate } from "./routes";
import { makeInstall, REPOSITORY, seedSource, within, type Install } from "./transfer.fixture";

/* `delegatus export` and `delegatus import` (install-memory-transfer §4.2)
   against the real routes, service and worker, served from this process on
   an ephemeral loopback port, between two isolated installs. */

let parent: string;
let source: Install;
let target: Install;
let folderKey: string;
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
  folderKey = (await seedSource(source)).folderKey;
  fs.mkdirSync(path.join(target.root, "work", "beta"), { recursive: true });
  for (const install of [source, target]) await within(install, async () => { await ensureLegacyCollectionsImported(() => {}); ensureOperatorSpawnCapability(); });
  server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    const req = new NextRequest(request);
    const pathname = new URL(request.url).pathname;
    if (pathname === "/api/transfer/export") return postExport(req);
    if (pathname === "/api/transfer/preview") return postPreview(req);
    if (pathname === "/api/transfer/apply") return postApply(req);
    if (pathname === "/api/transfer/report") return getReport(req);
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
  }, 180_000);

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
    expect(await gate(PAGE)).toBeNull();
    expect(await gate({ host: "127.0.0.1:8898", ...await within(target, () => internalServiceHeaders("controller")) })).toBeNull();
    for (const headers of <Record<string, string>[]>[
      { host: "127.0.0.1:8898", ...await within(target, () => internalServiceHeaders("mcp")) },
      { ...PAGE, "x-llv-spawn-capability": "A".repeat(43) },
      { host: "127.0.0.1:8898", origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" },
      { host: "127.0.0.1:8898" },
      { host: "127.0.0.1:8898", "x-llv-internal-service": `controller.${"0".repeat(64)}` },
    ]) {
      const refused = await gate(headers);
      expect(refused?.status).toBe(403);
    }
  });
});
