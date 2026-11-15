import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FileRuntimeEventStore } from "./eventStore";
import { readNativeTiming } from "./attemptTiming";
import { splitAttemptTime } from "@/lib/pipelines/accounting";
import type { RuntimeEvent } from "./engineHost";

const at = (ms: number) => new Date(ms).toISOString();
test("real native ledger writer retains observed model and tool intervals without scanning the ledger", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-timing-"));
  const store = new FileRuntimeEventStore(root);
  const events: RuntimeEvent[] = [
    { kind: "turn-started", turnId: "turn", seq: 1, accountingAt: at(10) },
    { kind: "item", turnId: "turn", seq: 2, phase: "started", item: { type: "commandExecution", id: "tool" }, accountingAt: at(20) },
    { kind: "item", turnId: "turn", seq: 3, phase: "completed", item: { type: "commandExecution", id: "tool" }, accountingAt: at(40) },
    { kind: "turn-ended", turnId: "turn", seq: 4, status: "completed", accountingAt: at(80) },
  ];
  for (const event of events) store.append("session", event);
  fs.unlinkSync(path.join(root, "session.jsonl"));
  expect(splitAttemptTime(at(0), at(100), readNativeTiming("session", root))).toMatchObject({ modelMs: 50, toolsMs: 20, unknownMs: 30 });
  expect(readNativeTiming("other", root)).toEqual([]);
});
test.each(["history", "missing-tool-start", "open-tool", "backwards"])("uncertain native time remains unknown: %s", mode => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-unknown-"));
  const store = new FileRuntimeEventStore(root);
  store.append("session", { kind: "turn-started", turnId: "turn", seq: 1, ...(mode === "history" ? {} : { accountingAt: at(10) }) });
  if (mode === "missing-tool-start" || mode === "open-tool") store.append("session", {
    kind: "item", turnId: "turn", seq: 2, accountingAt: at(20), phase: mode === "open-tool" ? "started" : "completed", item: { type: "mcpToolCall", id: "tool" },
  });
  store.append("session", { kind: "turn-ended", turnId: "turn", seq: mode === "missing-tool-start" || mode === "open-tool" ? 3 : 2,
    status: "completed", accountingAt: at(mode === "backwards" ? 0 : 50) });
  expect(readNativeTiming("session", root)).toEqual([]);
});
test("a real process restart preserves completed time and refuses to close a lost owner's turn", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-restart-"));
  new FileRuntimeEventStore(root).append("session", { kind: "turn-started", turnId: "lost", seq: 1, accountingAt: at(10) });
  const child = Bun.spawn([process.execPath, "-e", `
    import { FileRuntimeEventStore } from "./src/lib/runtime/eventStore";
    import { readNativeTiming } from "./src/lib/runtime/attemptTiming";
    const root = process.argv[1]; const store = new FileRuntimeEventStore(root);
    store.append("session", { kind: "turn-ended", turnId: "lost", seq: 2, status: "completed", accountingAt: new Date(50).toISOString() });
    store.append("session", { kind: "turn-started", turnId: "fresh", seq: 3, accountingAt: new Date(60).toISOString() });
    store.append("session", { kind: "turn-ended", turnId: "fresh", seq: 4, status: "completed", accountingAt: new Date(80).toISOString() });
    console.log(JSON.stringify(readNativeTiming("session", root)));
  `, root], { stdout: "pipe", stderr: "pipe", env: { ...process.env } });
  const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  expect({ code, errors }).toEqual({ code: 0, errors: "" });
  expect(JSON.parse(output)).toEqual([{ kind: "model", start: 60, end: 80 }]);
  expect(readNativeTiming("session", root)).toEqual(JSON.parse(output));
});


test("replacement of a native ledger cannot reuse a previous generation's time", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-generation-"));
  const first = new FileRuntimeEventStore(root);
  first.append("session", { kind: "turn-started", turnId: "old", seq: 1, accountingAt: at(10) });
  first.append("session", { kind: "turn-ended", turnId: "old", seq: 2, status: "completed", accountingAt: at(50) });
  fs.renameSync(path.join(root, "session.jsonl"), path.join(root, "previous.jsonl"));
  const next = new FileRuntimeEventStore(root);
  next.append("session", { kind: "turn-started", turnId: "new", seq: 1, accountingAt: at(100) });
  next.append("session", { kind: "turn-ended", turnId: "new", seq: 2, status: "completed", accountingAt: at(150) });
  expect(readNativeTiming("session", root)).toEqual([{ kind: "model", start: 100, end: 150 }]);
  expect(splitAttemptTime(at(10), at(50), readNativeTiming("session", root))).toMatchObject({ modelMs: null, unknownMs: 40 });
});
