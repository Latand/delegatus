import fs from "node:fs";
import path from "node:path";
import { darwinProcessArgv } from "../src/lib/proc/darwinArgv";
import { windowsBackend } from "../src/lib/proc/windows";

export function isBunTestProcess(): boolean {
  const argv = process.platform === "linux"
    ? fs.readFileSync("/proc/self/cmdline", "utf8").split("\0").filter(Boolean)
    : process.platform === "darwin" ? darwinProcessArgv(process.pid) : windowsBackend.readArgv(process.pid);
  if (!argv) throw new Error("test admission could not read the worker's command line");
  const index = argv.indexOf("test", 1);
  if (index < 0) return false;
  // Runtime flags can precede the subcommand. A script argument named test
  // follows its real entry point and must not enroll the enclosing script.
  const entry = process.argv[1];
  return !entry || !argv.slice(1, index).some(arg => !arg.startsWith("-") && path.resolve(arg) === path.resolve(entry));
}
