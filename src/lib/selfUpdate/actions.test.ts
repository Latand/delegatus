import { afterAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, readFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { installAction, runInstallAction } from "./actions";
const record = { launcher: { pid: 12, startIdentity: "7" }, checkout: "/srv/checkout", releasePointer: "/state/release.json" };
test("legacy systemd launcher offers one external restart", async () => {
  const action = await installAction({ mode: "checkout", record } as never, {
    cgroup: () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/delegatus.service", ready: () => true,
  });
  expect(action).toMatchObject({ id: "restart-service", button: true, unit: "delegatus.service" });
  const calls: string[][] = [];
  runInstallAction(action!, command => calls.push(command));
  expect(calls[0]?.slice(0, 4)).toEqual(["systemd-run", "--user", "--collect", "--quiet"]);
  expect(calls[0]?.slice(-4)).toEqual(["systemctl", "--user", "restart", "delegatus.service"]);
});
test("terminal legacy launcher gives its single command", async () => {
  expect(await installAction({ mode: "checkout", record } as never, { cgroup: () => "", ready: () => true }))
    .toMatchObject({ id: "restart-terminal", button: false });
});
test("an unbuilt upgrade needs Update first", async () => {
  expect(await installAction({ mode: "checkout", record } as never, { cgroup: () => "", ready: () => false }))
    .toMatchObject({ id: "update-first", button: true });
});
test("new and Docker launchers need no bootstrap action", async () => {
  expect(await installAction({ mode: "checkout", record: { ...record, launcher: { ...record.launcher, relaunch: 1 } } } as never)).toBeNull();
  expect(await installAction({ mode: "managed", record: null, reason: null })).toBeNull();
});

test("terminal bootstrap preserves a custom port and safe access arguments", async () => {
  const action = await installAction({ mode: "checkout", record: { ...record, port: 45678 } } as never,
    { cgroup: () => "", ready: () => true, argv: () => ["bun", "/srv/checkout/bin/cli.mjs", "--port", "45678", "--hostname", "0.0.0.0", "--tailscale", "--new-token"] });
  expect(action?.command).toContain("'45678'");
  expect(action?.command).toContain("'--tailscale'");
  expect(action?.command).not.toContain("--new-token");
});


test("manual no-record launch preserves the Viewer's custom listener", async () => {
  const action = await installAction({ mode: "unsupported", record: null, reason: "no-launcher", installRoot: "/srv/manual" },
    { cgroup: () => "", ready: () => false, env: { PORT: "45678", HOSTNAME: "0.0.0.0" } });
  expect(action).toMatchObject({ id: "start-launcher", button: false });
  expect(action?.command).toContain("'--port' '45678'");
  expect(action?.command).toContain("'--hostname' '0.0.0.0'");
});


test("Windows prerequisite uses PowerShell invocation and quote escaping", async () => {
  const action = await installAction({ mode: "checkout", record } as never,
    { cgroup: () => "", ready: () => true, platform: "win32", argv: () => [], env: {} }, "/srv/fixture's install");
  expect(action?.command).toStartWith("& '");
  expect(action?.command).toContain("fixture''s install");
  expect(action?.command).not.toContain("'\\''");
});


const packageFixtures: string[] = [];
afterAll(() => packageFixtures.forEach(root => rmSync(root, { recursive: true, force: true })));
test.each(["linux", "win32"] as const)("an old packaged bootstrap starts the verified new entry with retained install identity: %s", async platform => {
  const root = mkdtempSync("/var/tmp/package-action-"); packageFixtures.push(root);
  const next = join(root, "next"); mkdirSync(join(root, "bin")); mkdirSync(join(next, "bin"), { recursive: true }); mkdirSync(join(next, "dist", "standalone"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "delegatus-cli", version: "1.0.0" }));
  writeFileSync(join(root, "bin", "cli.mjs"), "// actual old bootstrap has no package-pointer protocol\n");
  writeFileSync(join(next, "package.json"), JSON.stringify({ name: "delegatus-cli", version: "1.0.1" }));
  writeFileSync(join(next, "bin", "launcher-relaunch.mjs"), "delegatus-launcher-relaunch-v1");
  writeFileSync(join(next, "dist", "standalone", "server.js"), ""); writeFileSync(join(next, "dist", "runtime-host.mjs"), "");
  const pointer = join(root, "pointer.json"); writeFileSync(pointer, JSON.stringify({ kind: "package", baseVersion: "1.0.0", version: "1.0.1", dir: next, sha: "a".repeat(40) }));
  const action = await installAction({ mode: "package", reason: null, record: { ...record, checkout: null, installRoot: root, releasePointer: pointer, port: 45678 } } as never,
    { cgroup: () => "", ready: () => true, platform, argv: () => [] });
  const command = platform === "win32" ? Buffer.from(action!.command!.split(" ").at(-1)!.replaceAll("'", ""), "base64").toString("utf16le") : action!.command!;
  expect(command).toContain(join(next, "bin", "cli.mjs"));
  expect(command).toContain("LLV_LAUNCHER_INSTALL_ROOT"); expect(command).toContain(root);
  expect(command).toContain("--port"); expect(command).toContain("45678");
});


test.each(["darwin", "win32"] as const)("legacy bootstrap retains Viewer bind when native argv is unavailable: %s", async platform => {
  const action = await installAction({ mode: "checkout", record: { ...record, port: 45678 } } as never,
    { cgroup: () => "", ready: () => true, platform, argv: () => [], env: { HOSTNAME: "0.0.0.0" } });
  expect(action?.command).toContain("'--port' '45678'");
  expect(action?.command).toContain("'--hostname' '0.0.0.0'");
});

test.each(["linux", "win32"] as const)("terminal context escapes state/config and excludes credentials: %s", async platform => {
  const state = "/srv/state ' $(literal); spaced";
  const config = "/srv/config ' $(literal); spaced";
  const action = await installAction({ mode: "checkout", record } as never, {
    cgroup: () => "", ready: () => true, platform, env: { HOME: "/srv/fixture home", LLV_STATE_DIR: state, XDG_CONFIG_HOME: config } as never,
  });
  expect(action?.command).toContain(platform === "win32" ? "$env:HOME=" : "HOME=");
  expect(action?.command).toContain("LLV_STATE_DIR");
  expect(action?.command).toContain("XDG_CONFIG_HOME");
  expect(action?.command).not.toContain("synthetic-secret");
  expect(action?.command).not.toContain("LLV_TOKEN");
  const escaped = platform === "win32" ? state.replaceAll("'", "''") : state.replaceAll("'", "'\\''");
  expect(action?.command).toContain(escaped);
});

test.each(["linux", "win32"] as const)("an env-only gate with unavailable private storage refuses its command: %s", async platform => {
  const action = await installAction({ mode: "unsupported", record: null, reason: "no-launcher", installRoot: "/srv/nonexistent-fixture" },
    { cgroup: () => "", ready: () => false, platform, env: { LLV_TOKEN: "synthetic-key" } });
  expect(action).toEqual({ id: "secure-handoff", button: false });
});

test("a leftover custody module cannot make an old CLI a credential reader", async () => {
  const root = mkdtempSync("/var/tmp/legacy-custody-reader-"); packageFixtures.push(root);
  mkdirSync(join(root, "bin")); mkdirSync(join(root, "state"));
  writeFileSync(join(root, "bin", "cli.mjs"), "// legacy launcher without a custody reader\n");
  copyFileSync(resolve("bin/launcher-credentials.mjs"), join(root, "bin", "launcher-credentials.mjs"));
  const action = await installAction({ mode: "unsupported", reason: "no-launcher", record: null, installRoot: root },
    { cgroup: () => "", ready: () => false, env: { LLV_STATE_DIR: join(root, "state"), LLV_TOKEN: "synthetic-key" } });
  expect(action).toEqual({ id: "secure-handoff", button: false });
});


test("credential preflight refuses a launcher changed during its awaited readiness read", async () => {
  const decision = { mode: "checkout", record: { ...record, launcher: { ...record.launcher } } };
  let release!: () => void, entered!: () => void;
  const arrival = new Promise<void>(resolve => { entered = resolve; });
  const wait = new Promise<void>(resolve => { release = resolve; });
  const action = installAction(decision as never, { cgroup: () => "", env: {}, ready: async () => { entered(); await wait; return true; } });
  await arrival; decision.record.launcher.startIdentity = "successor"; release();
  expect(await action).toEqual({ id: "secure-handoff", button: false });
});


if (process.platform === "linux") for (const change of ["gate-expired", "new-work", "custody-changed"] as const)
test(`credential preflight fences the last genuine Git read: ${change}`, async () => {
  const root = mkdtempSync("/var/tmp/credential-dispatch-"); packageFixtures.push(root);
  const state = join(root, "state"), dir = join(state, "self-update"), bin = join(root, "bin");
  mkdirSync(dir, { recursive: true }); mkdirSync(bin); mkdirSync(join(root, ".next"));
  for (const name of ["cli.mjs", "launcher-credentials.mjs"]) copyFileSync(resolve("bin", name), join(bin, name));
  writeFileSync(join(root, ".next", "BUILD_ID"), "fixture");
  const git = Bun.which("git")!;
  const run = (...args: string[]) => {
    const result = spawnSync(git, args, { cwd: root, encoding: "utf8" });
    expect(result.status).toBe(0); return result.stdout.trim();
  };
  run("init", "-q", "-b", "main"); run("add", ".");
  run("-c", "user.name=Fixture", "-c", "user.email=noreply@example.invalid", "commit", "-qm", "credential fixture");
  const sha = run("rev-parse", "HEAD");
  const requestFile = join(dir, "request.json"), pointer = join(dir, "release.json"), gate = join(dir, "auto-admission.json");
  writeFileSync(pointer, JSON.stringify({ sha, dir: root, checkoutHead: sha }));
  writeFileSync(gate, JSON.stringify({ id: "owned-preflight", until: Date.now() + 60000 }));
  const decision = { mode: "checkout", record: { ...record, checkout: root, requestFile, releasePointer: pointer, socket: "fixture-socket", launcher: { ...record.launcher } } };
  const entered = join(root, "entered"), release = join(root, "release"), count = join(root, "count");
  writeFileSync(join(bin, "git"), `#!/bin/sh
n=0
[ ! -f "$CREDENTIAL_COUNT" ] || n=$(cat "$CREDENTIAL_COUNT")
n=$((n+1))
printf "%s" "$n" > "$CREDENTIAL_COUNT"
if [ "$n" = 2 ]; then touch "$CREDENTIAL_ENTERED"; while [ ! -f "$CREDENTIAL_RELEASE" ]; do sleep 0.01; done; fi
exec "$CREDENTIAL_GIT" "$@"
`, { mode: 0o700 });
  const names = ["PATH", "CREDENTIAL_COUNT", "CREDENTIAL_ENTERED", "CREDENTIAL_RELEASE", "CREDENTIAL_GIT"] as const;
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  Object.assign(process.env, { PATH: `${bin}:${process.env.PATH}`, CREDENTIAL_COUNT: count, CREDENTIAL_ENTERED: entered, CREDENTIAL_RELEASE: release, CREDENTIAL_GIT: git });
  let pending;
  try {
    pending = installAction(decision as never, { cgroup: () => "", ready: () => true, env: { LLV_STATE_DIR: state } });
    const deadline = Date.now() + 1500;
    while (!existsSync(entered) && Date.now() < deadline) await Bun.sleep(5);
    expect(existsSync(entered)).toBe(true);
    if (change === "gate-expired") writeFileSync(gate, JSON.stringify({ id: "owned-preflight", until: 0 }));
    if (change === "new-work") writeFileSync(join(state, "agent-registry.json"), JSON.stringify({ accepted: "new-turn" }));
    if (change === "custody-changed") decision.record.launcher.startIdentity = "successor";
    const pointerBefore = readFileSync(pointer, "utf8"), gateBefore = readFileSync(gate, "utf8");
    writeFileSync(release, "");
    expect(await pending).toEqual({ id: "secure-handoff", button: false });
    expect(readFileSync(pointer, "utf8")).toBe(pointerBefore); expect(readFileSync(gate, "utf8")).toBe(gateBefore);
    expect(existsSync(requestFile)).toBe(false);
  } finally {
    writeFileSync(release, ""); await pending;
    for (const name of names) { if (previous[name] === undefined) delete process.env[name]; else process.env[name] = previous[name]; }
  }
});
