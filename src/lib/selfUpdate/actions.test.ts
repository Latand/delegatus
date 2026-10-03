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
