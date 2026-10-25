import fs from "node:fs";
import path from "node:path";
import { updateCodex, type UpdatePorts } from "./update";
import { withCodexCliLaunch } from "./installation";
import { createCodexUpdateTicker } from "./scheduler";

const [root, mode, now] = process.argv.slice(2) as [string, string, string];
const binary = path.join(root, "bin/codex");
const log = (line: string) => fs.appendFileSync(path.join(root, "calls"), `${line}\n`);
const ports: UpdatePorts = {
  now: () => Number(now), current: () => true,
  compatibilityKey: () => mode === "new-contract" ? "fixture-v2" : "fixture-v1",
  latest: async () => { log("latest"); return "0.164.0"; },
  version: async file => JSON.parse(fs.readFileSync(path.join(path.dirname(fs.realpathSync(file)), "../package.json"), "utf8")).version,
  install: async () => { log("install"); return path.join(root, "candidate/node_modules/@openai/codex/bin/codex.js"); },
  probe: async () => { log("probe"); if (mode === "fail") throw new Error("probe failed"); },
  idle: async () => mode !== "busy",
  report: async notice => log(notice.line),
};
if (mode === "scheduler-fail") {
  await createCodexUpdateTicker({ clockFile: path.join(root, "scheduler.json"), now: ports.now, current: ports.current,
    update: async () => { log("scheduler update"); throw new Error("unwritable location"); }, report: ports.report })();
} else if (mode === "hold-launch") {
  await withCodexCliLaunch(binary, async () => {
    process.stdout.write("ready\n");
    await new Promise<void>(resolve => process.stdin.once("data", () => resolve()));
  });
} else await updateCodex(binary, ports, mode === "rollback");
