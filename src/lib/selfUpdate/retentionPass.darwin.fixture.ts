import { mock } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const directory = process.env.LLV_TEST_RETENTION_PROBE_DIR!;
const entry = path.basename(process.argv[1]!);
Object.defineProperty(process, "platform", { value: "darwin" });
fs.writeFileSync(path.join(directory, `${entry}.pid`), String(process.pid));

const procReads = path.join(directory, "proc-reads");
const rejectProcRead = (file: unknown) => {
  const pathname = String(file);
  if (pathname !== "/proc" && !pathname.startsWith("/proc/")) return;
  fs.appendFileSync(procReads, `${entry}: ${pathname}\n`);
  throw Object.assign(new Error("procfs is absent on Darwin"), { code: "ENOENT" });
};
const observe = (method: "readFileSync" | "readlinkSync" | "readdirSync") => {
  const original = fs[method];
  return (file: unknown, ...args: unknown[]) => {
    rejectProcRead(file);
    return Reflect.apply(original, fs, [file, ...args]);
  };
};
const observed = { ...fs, readFileSync: observe("readFileSync"), readlinkSync: observe("readlinkSync"), readdirSync: observe("readdirSync") };
// Bun resolves named builtin exports separately from the default export.
mock.module("node:fs", () => ({ ...observed, default: observed }));
