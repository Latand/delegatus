import { EventEmitter } from "node:events";
import { afterAll, expect, spyOn, test } from "bun:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { claudeKeychainService, readClaudeCredentials, replaceClaudeCredentials, type ClaudeCredentialPorts } from "./claudeCredentials";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-credential-store-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
const home = () => fs.mkdtempSync(path.join(root, "account-"));
const fixture = () => crypto.randomUUID();
const document = () => ({ claudeAiOauth: { accessToken: fixture(), refreshToken: crypto.randomUUID(), expiresAt: Date.now() + 3600_000, scopes: ["user:inference", "user:profile"], subscriptionType: "max" } });

test("explicit account directories use the provider NFC hash, including the default directory", () => {
  const dir = "/fixture/cafe\u0301";
  expect(claudeKeychainService(dir)).toBe(`Claude Code-credentials-${crypto.createHash("sha256").update(dir.normalize("NFC")).digest("hex").slice(0, 8)}`);
  expect(claudeKeychainService(dir)).toBe(claudeKeychainService(dir.normalize("NFC")));
  expect(claudeKeychainService(path.join(os.homedir(), ".claude"))).toMatch(/^Claude Code-credentials-[a-f0-9]{8}$/);
});

test("Keychain wins over a stale safe file and never borrows another account", () => {
  const a = home(), b = home(), stored = document();
  fs.writeFileSync(path.join(a, ".credentials.json"), JSON.stringify(document()), { mode: 0o600 });
  const calls: string[][] = [];
  const ports: ClaudeCredentialPorts = { platform: "darwin", security: (args) => {
    calls.push(args);
    return args.at(-1) === claudeKeychainService(a) ? { status: 0, stdout: JSON.stringify(stored) } : { status: 44, stdout: "" };
  } };
  expect(readClaudeCredentials(a, ports)).toEqual({ state: "present", source: "keychain", document: stored });
  expect(readClaudeCredentials(b, ports)).toEqual({ state: "absent" });
  expect(calls).toHaveLength(2);
  expect(calls.every((args) => args.includes("-a") && args.includes("-s"))).toBe(true);
});

test("denial, locked stores, timeout and malformed records stay unknown without file fallback", () => {
  const dir = home();
  fs.writeFileSync(path.join(dir, ".credentials.json"), JSON.stringify(document()), { mode: 0o600 });
  for (const status of [36, 51, 1, null]) {
    expect(readClaudeCredentials(dir, { platform: "darwin", security: () => ({ status, stdout: "" }) })).toEqual({ state: "unknown" });
  }
  for (const stdout of ["malformed", "[]", "{}", '{"claudeAiOauth":null}']) {
    expect(readClaudeCredentials(dir, { platform: "darwin", security: () => ({ status: 0, stdout }) })).toEqual({ state: "unknown" });
  }
});

test("unsafe mode and symlinks cannot be bypassed through Keychain", () => {
  const dir = home(), file = path.join(dir, ".credentials.json");
  const ports: ClaudeCredentialPorts = { platform: "darwin", security: () => { throw new Error("must not read Keychain"); } };
  fs.writeFileSync(file, "{}", { mode: 0o644 });
  expect(readClaudeCredentials(dir, ports)).toEqual({ state: "unsafe" });
  fs.unlinkSync(file); fs.symlinkSync(path.join(root, "missing"), file);
  expect(readClaudeCredentials(dir, ports)).toEqual({ state: "unsafe" });
});

test("file-backed rotation remains private and refuses a concurrent replacement", () => {
  const dir = home(), file = path.join(dir, ".credentials.json"), stored = document();
  const ports: ClaudeCredentialPorts = { platform: "linux", security: () => { throw new Error("unexpected Keychain call"); } };
  fs.writeFileSync(file, JSON.stringify(stored), { mode: 0o600 });
  const read = readClaudeCredentials(dir, ports);
  if (read.state !== "present") throw new Error("missing fixture");
  expect(replaceClaudeCredentials(dir, read, document(), ports)).toBe(true);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(replaceClaudeCredentials(dir, read, document(), ports)).toBe(false);
});

test("Keychain rotation uses stdin, verifies readback, and never falls back to plaintext", () => {
  const dir = home(); let stored = document();
  const commands: string[][] = [];
  const ports: ClaudeCredentialPorts = { platform: "darwin", security: (args, input) => {
    commands.push(args);
    if (input) stored = JSON.parse(Buffer.from(input.match(/-X "([a-f0-9]+)"/)![1], "hex").toString());
    return { status: 0, stdout: JSON.stringify(stored) };
  } };
  const read = readClaudeCredentials(dir, ports);
  if (read.state !== "present") throw new Error("missing fixture");
  const next = document();
  expect(replaceClaudeCredentials(dir, read, next, ports)).toBe(true);
  expect(commands).toContainEqual(["-i"]);
  expect(JSON.stringify(commands)).not.toContain(next.claudeAiOauth.accessToken);
  expect(fs.readdirSync(dir)).toEqual([]);
  const current = readClaudeCredentials(dir, ports);
  if (current.state !== "present") throw new Error("missing fixture");
  expect(replaceClaudeCredentials(dir, current, { ...next, oversized: "x".repeat(4096) }, ports)).toBe(false);
});

if (process.env.LLV_REQUIRE_NATIVE_CREDENTIALS === "1" && process.platform !== "darwin") {
  throw new Error("native credential proof requires macOS");
}

test.skipIf(process.env.LLV_REQUIRE_NATIVE_CREDENTIALS !== "1")("native disposable Keychain and published Claude agree on account ownership", async () => {
  const keychain = path.join(root, "fixture.keychain-db");
  const passphrase = crypto.randomUUID();
  const security = (args: string[], input?: string) => {
    const result = spawnSync("/usr/bin/security", args, { input, encoding: "utf8", timeout: 5000 });
    return { status: result.status, stdout: result.stdout ?? "" };
  };
  expect(security(["create-keychain", "-p", passphrase, keychain]).status).toBe(0);
  try {
    expect(security(["unlock-keychain", "-p", passphrase, keychain]).status).toBe(0);
    const ports: ClaudeCredentialPorts = { platform: "darwin", security: (args, input) =>
      input ? security(args, input.trimEnd() + ` "${keychain}"\n`) : security([...args, keychain]) };
    const accounts = await import("./claude");
    const a = accounts.legacyClaudeHome();
    fs.mkdirSync(a, { recursive: true, mode: 0o700 });
    const managed = accounts.createManagedClaudeAccount("Native fixture");
    const b = managed.home, wrong = home(), stored = document();
    const user = process.env.USER!;
    for (const dir of [a, b]) {
      expect(security(["-i"], `add-generic-password -a "${user}" -s "${claudeKeychainService(dir)}" -X "${Buffer.from(JSON.stringify(stored)).toString("hex")}" "${keychain}"\n`).status).toBe(0);
    }
    const read = readClaudeCredentials(a, ports);
    expect(read.state).toBe("present");
    expect(readClaudeCredentials(b, ports).state).toBe("present");
    expect(readClaudeCredentials(wrong, ports).state).toBe("absent");

    // Route security calls to ONLY this explicit keychain; never change the
    // login keychain or its search list. The CLI still derives its own service.
    const bin = path.join(root, "bin"); fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "security"), '#!/bin/sh\ncase "$1" in\nfind-generic-password) exec /usr/bin/security "$@" "$LLV_TEST_KEYCHAIN" ;;\n*) exit 1 ;;\nesac\n', { mode: 0o700 });
    const provider = process.env.LLV_TEST_CLAUDE_BINARY;
    if (!provider) throw new Error("published Claude binary is required");
    const { claudeManagedEnvironment } = await import("./claude");
    const status = (dir: string) => {
      const result = spawnSync(provider, ["auth", "status", "--json"], {
        env: { ...claudeManagedEnvironment(dir), PATH: `${bin}:${process.env.PATH}`, LLV_TEST_KEYCHAIN: keychain,
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", HTTPS_PROXY: "http://127.0.0.1:9", HTTP_PROXY: "http://127.0.0.1:9" },
        encoding: "utf8", timeout: 15000,
      });
      if (result.error) throw new Error("provider status did not finish");
      return JSON.parse(result.stdout).loggedIn;
    };
    expect(status(a)).toBe(true);
    expect(status(b)).toBe(true);
    expect(status(wrong)).toBe(false);
    const store = await import("./claudeCredentials");
    const originalRead = store.readClaudeCredentials;
    const readPort = spyOn(store, "readClaudeCredentials").mockImplementation((dir) => originalRead(dir, ports));
    try {
      const { ClaudeLoginSupervisor } = await import("./claudeLogin");
      const { claudeOauthMetadata } = await import("./claudeOauth");
      for (const id of ["default", managed.id]) {
        const child = Object.assign(new EventEmitter(), { pid: 4242, stdout: new EventEmitter(), stderr: new EventEmitter(), stdin: { write: () => true, end: () => undefined } });
        const supervisor = new ClaudeLoginSupervisor({
          spawn: () => child as never, kill: () => { throw new Error("no lifecycle action expected"); },
          pidStartToken: () => "fixture-start", isExpectedClaude: () => true, waitForExit: async () => undefined,
          status: async (dir) => ({ loggedIn: status(dir), method: "oauth", email: null, plan: "max" }),
          now: Date.now, setTimeout: () => ({} as NodeJS.Timeout), clearTimeout: () => undefined,
        }, { load: () => [], save: () => undefined });
        const operation = supervisor.start(id);
        child.emit("close", 0);
        await new Promise((resolve) => setImmediate(resolve));
        expect(supervisor.get(operation.operationId)?.phase).toBe("authenticated");
        const candidate = accounts.listClaudeAccounts().find((account) => account.id === id)!;
        expect(candidate.authPresent).toBe(true);
        expect(claudeOauthMetadata(candidate)).toMatchObject({ refreshable: true });
      }
    } finally { readPort.mockRestore(); }
    if (read.state !== "present") throw new Error("missing native fixture");
    expect(replaceClaudeCredentials(a, read, document(), ports)).toBe(true);
    expect(fs.existsSync(path.join(a, ".credentials.json"))).toBe(false);
    expect(security(["lock-keychain", keychain]).status).toBe(0);
    expect(readClaudeCredentials(a, ports).state).toBe("unknown");
    expect(fs.existsSync(path.join(a, ".credentials.json"))).toBe(false);
  } finally {
    expect(security(["delete-keychain", keychain]).status).toBe(0);
  }
}, 60000);
