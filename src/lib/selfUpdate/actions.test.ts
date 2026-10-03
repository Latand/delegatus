import { expect, test } from "bun:test";
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
