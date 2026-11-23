import fs from "node:fs";
import path from "node:path";
import { recordedCheck } from "./api";
import { readEnvelope, writeEnvelope } from "./wire";

const input = readEnvelope(process.argv[2]!) as {
  caller: string; ticket: string; request: string; stateDirectory: string; retrying: string; answer: string;
};
const watch = fs.watch;
let reportedWait = false;
fs.watch = ((...args: Parameters<typeof watch>) => {
  const watcher = watch(...args);
  if (!reportedWait && path.resolve(String(args[0])) === input.stateDirectory) {
    reportedWait = true;
    writeEnvelope(input.retrying, { pid: process.pid });
  }
  return watcher;
}) as typeof watch;
writeEnvelope(`${input.answer}.started`, { pid: process.pid });
try {
  const result = await recordedCheck({ action: "handoff", ticket: input.ticket, clientRequestId: input.request }, input.caller);
  writeEnvelope(input.answer, { result });
} catch (error) {
  writeEnvelope(input.answer, { error: error instanceof Error ? error.message : String(error) });
  process.exitCode = 1;
}
