import { expect, spyOn, test } from "bun:test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { observeCommandExecution, timedCommand } from "./commandTiming";

test("a native command without a timing channel exits with unknown execution time", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(7)"], { stdio: "ignore" });
  const timing = observeCommandExecution(child);
  expect(await once(child, "close")).toEqual([7, null]);
  expect(await timing()).toEqual({});
});

test("exec timing excludes acknowledged setup and later cleanup, preserving argv and stdin", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(0);
  const argv = timedCommand(["/bin/bash", "-c", 'IFS= read -r value; printf "%s|%s" "$1" "$value"; exit 7', "fixture", "a b;$literal"],
    'printf "setup-ready\\n"; IFS= read -r ready; unset EPOCHREALTIME; EPOCHREALTIME=1.000000; ');
  const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "pipe", "pipe"] });
  const timing = observeCommandExecution(child);
  const closed = once(child, "close");
  let output = "";
  child.stdout!.on("data", chunk => { output += chunk.toString(); });
  try {
    await once(child.stdout!, "data");
    expect(output).toBe("setup-ready\n");
    expect(await timing()).toEqual({});
    clock.mockReturnValue(2000);
    child.stdin!.end("ready\npayload\n");
    expect(await closed).toEqual([7, null]);
    expect(output).toBe("setup-ready\na b;$literal|payload");
    clock.mockReturnValue(10000);
    expect(await timing()).toEqual({ executionStartedAt: 1000, executionEndedAt: 2000 });
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
    clock.mockRestore();
  }
});

test("a setup refusal has no execution interval", async () => {
  const argv = timedCommand(["/bin/true"], "exit 69; ");
  const child = spawn(argv[0]!, argv.slice(1), { stdio: ["ignore", "ignore", "ignore", "pipe"] });
  const timing = observeCommandExecution(child);
  expect(await once(child, "close")).toEqual([69, null]);
  expect(await timing()).toEqual({});
});

test("cancellation before the exec barrier records exit without inventing execution", async () => {
  const argv = timedCommand(["/bin/true"], 'printf "setup-ready\\n"; IFS= read -r ready; ');
  const child = spawn(argv[0]!, argv.slice(1), { stdio: ["pipe", "pipe", "ignore", "pipe"] });
  const timing = observeCommandExecution(child);
  const closed = once(child, "close");
  try {
    await once(child.stdout!, "data");
    expect(child.kill("SIGTERM")).toBe(true);
    expect(await closed).toEqual([null, "SIGTERM"]);
    expect(await timing()).toEqual({});
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await closed; }
  }
});
