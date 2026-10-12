import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pendingBackgroundTasks, readBackgroundTaskLedger } from "./backgroundTasks";

test("bounded activity reads advance the existing ledger and never expose an incomplete prefix as pending work", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "activity-ledger-"));
  const file = path.join(dir, "one.jsonl");
  try {
    const records = [
      { type: "user", timestamp: "2026-10-12T12:00:00Z", toolUseResult: { backgroundTaskId: "task-one" }, message: { content: [{ type: "tool_result", tool_use_id: "check-one", content: "running" }] } },
      ...Array.from({ length: 5 }, () => ({ type: "system", content: "padding".repeat(100) })),
      { type: "user", message: { content: "<task-notification><task-id>task-one</task-id><status>completed</status></task-notification>" } },
    ];
    fs.writeFileSync(file, records.map(record => JSON.stringify(record)).join("\n")+"\n");
    expect(await readBackgroundTaskLedger(file, { maxBytes: 1200 })).toBeNull();
    expect(await readBackgroundTaskLedger(file, { maxBytes: 1200 })).toBeNull();
    let ledger = null;
    for (let count = 0; count < 6 && ledger === null; count++) ledger = await readBackgroundTaskLedger(file, { maxBytes: 1200 });
    expect(ledger).not.toBeNull();
    expect(pendingBackgroundTasks(ledger!, Date.now())).toEqual([]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
