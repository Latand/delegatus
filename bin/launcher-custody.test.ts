import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installAction } from "../src/lib/selfUpdate/actions";
import { prepareLauncherCredentials, releaseLauncherCredentials, restoreLauncherCredentials, setCustodyAclRunnerForTests } from "./launcher-credentials.mjs";

/*
 * Launcher credential custody serves one handoff. These cases hold its life
 * cycle: who is handed the held key, when custody is dropped, and how many
 * PowerShell processes a Windows install pays for it.
 */

const roots: string[] = [];
const platform = process.platform;
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
  setCustodyAclRunnerForTests();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function install() {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "dlg-custody-life-"))); roots.push(root);
  const base = path.join(root, "package"), state = path.join(root, "state"), control = path.join(state, "self-update");
  mkdirSync(base); mkdirSync(control, { recursive: true });
  const id = createHash("sha256").update(path.resolve(base)).digest("hex").slice(0, 16);
  const key = () => randomBytes(32).toString("hex");
  const env = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ HOME: path.join(root, "home"), XDG_CONFIG_HOME: path.join(root, "config"), LLV_STATE_DIR: state, ...extra }) as unknown as NodeJS.ProcessEnv;
  return { root, base, state, control, id, key, env, directory: path.join(state, `launcher-custody-${id}`) };
}

test("a start without an open handoff keeps its own settings and drops leftover custody", () => {
  const f = install(); const held = f.key();
  expect(prepareLauncherCredentials(f.base, f.env({ LLV_TOKEN: held, LLV_PUBLIC_HOST: "held.example" }))).toBe(true);
  // A command that starts no launcher neither reads nor settles custody.
  const oneShot = f.env({ LLV_TOKEN: f.key() }), given = oneShot.LLV_TOKEN;
  restoreLauncherCredentials(f.base, oneShot);
  expect(oneShot.LLV_TOKEN).toBe(given); expect(existsSync(f.directory)).toBe(true);
  // An ordinary launcher start is not handed the stored key.
  const keyless = f.env();
  restoreLauncherCredentials(f.base, keyless, { launch: true });
  expect(keyless.LLV_TOKEN).toBeUndefined(); expect(keyless.LLV_PUBLIC_HOST).toBeUndefined();
  expect(existsSync(f.directory)).toBe(false);
});

test("after a settled handoff a launcher starts with a changed key, and the next prerequisite has its command", async () => {
  const f = install(); const first = f.key(), second = f.key();
  expect(prepareLauncherCredentials(f.base, f.env({ LLV_TOKEN: first }))).toBe(true);
  const taken = f.env({ LLV_LAUNCHER_CREDENTIAL_HANDOFF: "1" });
  restoreLauncherCredentials(f.base, taken, { launch: true });
  expect(taken.LLV_TOKEN).toBe(first);
  // The process tree this handoff reached inherits the settings; custody is
  // neither read again nor dropped before the handoff settles.
  expect(taken.LLV_LAUNCHER_CREDENTIAL_HANDOFF).toBe("held");
  restoreLauncherCredentials(f.base, taken, { launch: true });
  expect(existsSync(f.directory)).toBe(true);
  releaseLauncherCredentials(f.base, f.env());
  expect(existsSync(f.directory)).toBe(false);

  // Without a settlement the same holds: a rotated or replaced key on an
  // ordinary start supersedes the record.
  expect(prepareLauncherCredentials(f.base, f.env({ LLV_TOKEN: first, LLV_PUBLIC_HOST: "first.example" }))).toBe(true);
  for (const changed of [{ LLV_TOKEN: second }, { LLV_TOKEN: first, LLV_PUBLIC_HOST: "second.example" }] as Record<string, string>[]) {
    const started = f.env(changed);
    restoreLauncherCredentials(f.base, started, { launch: true });
    expect(started.LLV_TOKEN).toBe(changed.LLV_TOKEN);
  }
  // The real entry point answers under the new key while old custody exists.
  expect(prepareLauncherCredentials(f.base, f.env({ LLV_TOKEN: first }))).toBe(true);
  for (const flag of ["--version", "--help"]) {
    const run = spawnSync(process.execPath, ["--bun", path.resolve("bin/cli.mjs"), flag], { env: { ...process.env, ...f.env({ LLV_TOKEN: second, LLV_LAUNCHER_INSTALL_ROOT: f.base }) }, encoding: "utf8", timeout: 30_000 });
    expect({ status: run.status, refused: (run.stdout + run.stderr).includes("handoff is unavailable") }).toEqual({ status: 0, refused: false });
  }

  // The Viewer of the restarted launcher prepares the next handoff under the
  // key it now has, and the operator gets a command.
  const started = f.env({ LLV_TOKEN: second });
  restoreLauncherCredentials(f.base, started, { launch: true });
  for (const name of ["cli.mjs", "launcher-credentials.mjs"]) {
    mkdirSync(path.join(f.base, "bin"), { recursive: true });
    writeFileSync(path.join(f.base, "bin", name), readFileSync(path.resolve("bin", name), "utf8"));
  }
  const action = await installAction({ mode: "unsupported", reason: "no-launcher", record: null, installRoot: f.base }, { cgroup: () => "", ready: () => false, env: started });
  expect(action?.id).toBe("start-launcher");
  expect(action?.command).toContain("LLV_LAUNCHER_CREDENTIAL_HANDOFF=");
  expect(action?.command?.includes(second)).toBe(false);
  const next = f.env({ LLV_LAUNCHER_CREDENTIAL_HANDOFF: "1" });
  restoreLauncherCredentials(f.base, next, { launch: true });
  expect(next.LLV_TOKEN).toBe(second);
});

test.each(["apply", "trial"] as const)("an interrupted handoff still restores its key on a cold start: open %s", shape => {
  const f = install(); const held = f.key();
  expect(prepareLauncherCredentials(f.base, f.env({ LLV_TOKEN: held, LLV_TS_HOST: "held.example" }))).toBe(true);
  if (shape === "apply") writeFileSync(path.join(f.control, "apply.json"), JSON.stringify({ requestId: "open", target: "b".repeat(40), state: "switching" }));
  else writeFileSync(path.join(f.control, `trial-${f.id}.json`), JSON.stringify({ requestId: "open", state: "starting" }));
  const cold = f.env();
  restoreLauncherCredentials(f.base, cold, { launch: true });
  expect(cold.LLV_TOKEN).toBe(held); expect(cold.LLV_TS_HOST).toBe("held.example");
  expect(existsSync(f.directory)).toBe(true);
  // The settings an operator gives a start win even while the handoff is open.
  const changed = f.env({ LLV_TOKEN: f.key() }), given = changed.LLV_TOKEN;
  restoreLauncherCredentials(f.base, changed, { launch: true });
  expect(changed.LLV_TOKEN).toBe(given); expect(existsSync(f.directory)).toBe(false);
  // A settled apply no longer hands the key to anyone.
  expect(prepareLauncherCredentials(f.base, f.env({ LLV_TOKEN: held }))).toBe(true);
  rmSync(path.join(f.control, `trial-${f.id}.json`), { force: true });
  writeFileSync(path.join(f.control, "apply.json"), JSON.stringify({ requestId: "open", target: "b".repeat(40), state: "done" }));
  const later = f.env();
  restoreLauncherCredentials(f.base, later, { launch: true });
  expect(later.LLV_TOKEN).toBeUndefined();
});

test("a refusal names its cause and the custody directory and shows no key", () => {
  const f = install(); const held = f.key(), other = f.key();
  expect(prepareLauncherCredentials(f.base, f.env({ LLV_TOKEN: held, LLV_PUBLIC_HOST: "held.example" }))).toBe(true);
  const message = (run: () => unknown) => { try { run(); } catch (error) { return (error as Error).message; } return null; };
  const key = message(() => restoreLauncherCredentials(f.base, f.env({ LLV_LAUNCHER_CREDENTIAL_HANDOFF: "1", LLV_TOKEN: other })));
  expect(key).toContain("Protected launcher handoff is unavailable"); expect(key).toContain("different access key"); expect(key).toContain(f.directory);
  const host = message(() => restoreLauncherCredentials(f.base, f.env({ LLV_LAUNCHER_CREDENTIAL_HANDOFF: "1", LLV_PUBLIC_HOST: "other.example" })));
  expect(host).toContain("different LLV_PUBLIC_HOST"); expect(host).toContain(f.directory);
  const stale = message(() => prepareLauncherCredentials(f.base, f.env({ LLV_TOKEN: other })));
  expect(stale).toContain("different access key"); expect(stale).toContain(f.directory);
  releaseLauncherCredentials(f.base, f.env());
  const missing = message(() => restoreLauncherCredentials(f.base, f.env({ LLV_LAUNCHER_CREDENTIAL_HANDOFF: "1" })));
  expect(missing).toContain("no handoff record exists");
  for (const text of [key, host, stale, missing]) { expect(text!.includes(held)).toBe(false); expect(text!.includes(other)).toBe(false); }
});

test("a Windows snapshot does not start PowerShell again for custody it already verified", () => {
  const f = install(); const held = f.key();
  const calls: { files: string[]; create: boolean }[] = [];
  Object.defineProperty(process, "platform", { value: "win32" });
  setCustodyAclRunnerForTests((files: string[], create: boolean) => { calls.push({ files, create }); return true; });
  const env = f.env({ LLV_TOKEN: held });
  expect(prepareLauncherCredentials(f.base, env)).toBe(true);
  const first = calls.length;
  // Before: 24 processes for the first snapshot and 14 for every later one.
  expect(first).toBeLessThanOrEqual(8);
  for (let snapshot = 0; snapshot < 5; snapshot++) expect(prepareLauncherCredentials(f.base, env)).toBe(true);
  expect(calls.length).toBe(first);

  // A launcher is a new process: it verifies the directory and both records
  // in one PowerShell process before reading the key.
  setCustodyAclRunnerForTests((files: string[], create: boolean) => { calls.push({ files, create }); return true; });
  const taken = f.env({ LLV_LAUNCHER_CREDENTIAL_HANDOFF: "1" });
  restoreLauncherCredentials(f.base, taken, { launch: true });
  expect(taken.LLV_TOKEN).toBe(held);
  expect(calls.slice(first)).toEqual([{ files: [f.directory, path.join(f.directory, "identity.json"), path.join(f.directory, "environment.json")], create: false }]);

  // Anything that touches an entry is verified again, and a refused ACL is
  // never remembered as verified.
  const handoff = calls.length;
  expect(prepareLauncherCredentials(f.base, env)).toBe(true);
  expect(calls.length).toBe(handoff);
  appendFileSync(path.join(f.directory, "identity.json"), " ");
  setCustodyAclRunnerForTests(() => false);
  expect(() => prepareLauncherCredentials(f.base, env)).toThrow("Protected launcher handoff is unavailable");
  expect(() => prepareLauncherCredentials(f.base, env)).toThrow("Protected launcher handoff is unavailable");
});
