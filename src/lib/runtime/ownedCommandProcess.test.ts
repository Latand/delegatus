import { expect, test } from "bun:test";
import { commandStatus, spawnOwnedCommand } from "./ownedCommandProcess";

const terminate = (signal: number) => ["python3", "-I", "-c", `import os,signal\nsignal.signal(${signal},signal.SIG_DFL)\nos.kill(os.getpid(),${signal})`];

function run(argv: string[], marker = false) {
  const child = spawnOwnedCommand(argv, { env: process.env, marker });
  let data = "";
  child.stdio[3]?.on("data", chunk => { data += String(chunk); });
  const exit = new Promise<[number | null, string | null]>(resolve => child.once("exit", (code, signal) => resolve([code, signal])));
  const close = new Promise<void>(resolve => child.once("close", () => resolve()));
  return { child, exit, close, data: () => data };
}

test("command status keeps 128+N for named and numbered signals and the caller's fallback otherwise", () => {
  expect(commandStatus(0, null)).toBe(0);
  expect(commandStatus(162, null)).toBe(162);
  expect(commandStatus(null, "SIGINT")).toBe(130);
  expect(commandStatus(null, "SIGUSR1")).toBe(138);
  expect(commandStatus(null, "SIGTERM")).toBe(143);
  expect(commandStatus(null, "SIG34")).toBe(162);
  expect(commandStatus(null, null)).toBe(137);
  expect(commandStatus(null, "SIGNOTREAL", 1)).toBe(1);
});

test.skipIf(process.platform !== "linux")("an unnamed real-time signal is reported by number, distinct from an explicit exit 162", async () => {
  const signalled = run(terminate(34));
  expect(await signalled.exit).toEqual([null, "SIG34"]);
  expect(signalled.child.exitCode).toBeNull();
  expect(signalled.child.signalCode as string).toBe("SIG34");
  const numeric = run(["python3", "-I", "-c", "raise SystemExit(162)"]);
  expect(await numeric.exit).toEqual([162, null]);
  const named = run(terminate(15));
  expect(await named.exit).toEqual([null, "SIGTERM"]);
});

test.skipIf(process.platform !== "linux")("the marker pipe delivers fd 3 and closes after exit", async () => {
  const marked = run(["/bin/bash", "-c", "printf 'marker\\n' >&3; exec 3>&-; exit 7"], true);
  expect(await marked.exit).toEqual([7, null]);
  await marked.close;
  expect(marked.data()).toBe("marker\n");
});

test("a command that cannot start reports an error without a pid", async () => {
  const child = spawnOwnedCommand(["/nonexistent/owned-command"], { env: process.env, marker: false });
  expect(child.pid).toBeUndefined();
  expect(await new Promise(resolve => child.once("error", resolve))).toBeInstanceOf(Error);
  expect(child.kill("SIGTERM")).toBeFalse();
});

test.skipIf(process.platform === "win32")("kill signals a running command once and refuses after exit", async () => {
  const running = run(["/bin/sh", "-c", "exec sleep 30"]);
  expect(running.child.kill("SIGTERM")).toBeTrue();
  expect(await running.exit).toEqual([null, "SIGTERM"]);
  expect(running.child.kill("SIGTERM")).toBeFalse();
});
