import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { installAction, runInstallAction } from "./actions";
const record = { launcher: { pid: 12, startIdentity: "7" }, checkout: "/srv/checkout", releasePointer: "/state/release.json" };
test("legacy systemd launcher offers one external restart", () => {
  const action = installAction({ mode: "checkout", record } as never, {
    cgroup: () => "0::/user.slice/user-1000.slice/user@1000.service/app.slice/delegatus.service", ready: () => true,
  });
  expect(action).toMatchObject({ id: "restart-service", button: true, unit: "delegatus.service" });
  const calls: string[][] = [];
  runInstallAction(action!, command => calls.push(command));
  expect(calls[0]?.slice(0, 4)).toEqual(["systemd-run", "--user", "--collect", "--quiet"]);
  expect(calls[0]?.slice(-4)).toEqual(["systemctl", "--user", "restart", "delegatus.service"]);
});
test("terminal legacy launcher gives its single command", () => {
  expect(installAction({ mode: "checkout", record } as never, { cgroup: () => "", ready: () => true }))
    .toMatchObject({ id: "restart-terminal", button: false });
});
test("an unbuilt upgrade needs Update first", () => {
  expect(installAction({ mode: "checkout", record } as never, { cgroup: () => "", ready: () => false }))
    .toMatchObject({ id: "update-first", button: true });
});
test("new and Docker launchers need no bootstrap action", () => {
  expect(installAction({ mode: "checkout", record: { ...record, launcher: { ...record.launcher, relaunch: 1 } } } as never)).toBeNull();
  expect(installAction({ mode: "managed", record: null, reason: null })).toBeNull();
});

test("terminal bootstrap preserves a custom port and safe access arguments", () => {
  const action = installAction({ mode: "checkout", record: { ...record, port: 45678 } } as never,
    { cgroup: () => "", ready: () => true, argv: () => ["bun", "/srv/checkout/bin/cli.mjs", "--port", "45678", "--hostname", "0.0.0.0", "--tailscale", "--new-token"] });
  expect(action?.command).toContain("'45678'");
  expect(action?.command).toContain("'--tailscale'");
  expect(action?.command).not.toContain("--new-token");
});


test("manual no-record launch preserves the Viewer's custom listener", () => {
  const action = installAction({ mode: "unsupported", record: null, reason: "no-launcher", installRoot: "/srv/manual" },
    { cgroup: () => "", ready: () => false, env: { PORT: "45678", HOSTNAME: "0.0.0.0" } });
  expect(action).toMatchObject({ id: "start-launcher", button: false });
  expect(action?.command).toContain("'--port' '45678'");
  expect(action?.command).toContain("'--hostname' '0.0.0.0'");
});


test("Windows prerequisite uses PowerShell invocation and quote escaping", () => {
  const action = installAction({ mode: "checkout", record } as never,
    { cgroup: () => "", ready: () => true, platform: "win32", argv: () => [] }, "/srv/fixture's install");
  expect(action?.command).toStartWith("& '");
  expect(action?.command).toContain("fixture''s install");
  expect(action?.command).not.toContain("'\\''");
});


const packageFixtures: string[] = [];
afterAll(() => packageFixtures.forEach(root => rmSync(root, { recursive: true, force: true })));
test.each(["linux", "win32"] as const)("an old packaged bootstrap starts the verified new entry with retained install identity: %s", platform => {
  const root = mkdtempSync("/var/tmp/package-action-"); packageFixtures.push(root);
  const next = join(root, "next"); mkdirSync(join(root, "bin")); mkdirSync(join(next, "bin"), { recursive: true }); mkdirSync(join(next, "dist", "standalone"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "delegatus-cli", version: "1.0.0" }));
  writeFileSync(join(root, "bin", "cli.mjs"), "// actual old bootstrap has no package-pointer protocol\n");
  writeFileSync(join(next, "package.json"), JSON.stringify({ name: "delegatus-cli", version: "1.0.1" }));
  writeFileSync(join(next, "bin", "launcher-relaunch.mjs"), "delegatus-launcher-relaunch-v1");
  writeFileSync(join(next, "dist", "standalone", "server.js"), ""); writeFileSync(join(next, "dist", "runtime-host.mjs"), "");
  const pointer = join(root, "pointer.json"); writeFileSync(pointer, JSON.stringify({ kind: "package", baseVersion: "1.0.0", version: "1.0.1", dir: next, sha: "a".repeat(40) }));
  const action = installAction({ mode: "package", reason: null, record: { ...record, checkout: null, installRoot: root, releasePointer: pointer, port: 45678 } } as never,
    { cgroup: () => "", ready: () => true, platform, argv: () => [] });
  const command = platform === "win32" ? Buffer.from(action!.command!.split(" ").at(-1)!.replaceAll("'", ""), "base64").toString("utf16le") : action!.command!;
  expect(command).toContain(join(next, "bin", "cli.mjs"));
  expect(command).toContain("LLV_LAUNCHER_INSTALL_ROOT"); expect(command).toContain(root);
  expect(command).toContain("--port"); expect(command).toContain("45678");
});
