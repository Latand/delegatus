import { spawn } from "node:child_process";
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "bun:test";
import { children, install, pointerFile, readRecord, registerSelfUpdateCleanup, release, start, until } from "./__fixtures__/cli-self-update";

registerSelfUpdateCleanup();

test("stop --all after a healthy release handoff exits the bootstrap without starting the installed version", async () => {
  const fixture = install();
  const next = release(fixture, "login-stop");
  for (const root of [fixture.checkout, next.dir]) copyFileSync(path.resolve("bin/stop-all.mjs"), path.join(root, "bin/stop-all.mjs"));
  mkdirSync(path.dirname(pointerFile(fixture)), { recursive: true });
  writeFileSync(pointerFile(fixture), JSON.stringify({ ...next, checkoutHead: fixture.first }));
  const running = await start(fixture);
  const before = await until(() => { const record = readRecord(fixture.state); return record.web.state === "healthy" && record.launcher.state === "healthy" ? record : null; });
  expect(before.launcher.pid).not.toBe(running.child.pid!);
  const command = spawn(process.execPath, [path.join(fixture.checkout, "bin/cli.mjs"), "stop", "--all"], { env: fixture.env, stdio: "ignore" });
  children.add(command);
  await until(() => command.exitCode !== null, 15_000);
  expect(command.exitCode).toBe(0);
  await until(() => running.child.exitCode !== null, 4000);
  expect(running.child.exitCode).toBe(0);
}, 25_000);
