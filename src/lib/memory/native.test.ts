import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { nativeHookCursor, nativeOccurrenceAfter } from "./native";
import { messageTextDigest } from "@/lib/runtime/messageTextDigest";

for (const engine of ["claude", "codex"] as const) test(`${engine} native cursor preserves byte positions through a split UTF-8 tail`, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "memory-native-bytes-"));
  const file = path.join(root, "synthetic.jsonl");
  const prefix = JSON.stringify({ type: "assistant", message: { role: "assistant", content: "龘".repeat(90000) } }) + "\n";
  const user = (id: string) => JSON.stringify(engine === "claude"
    ? { type: "user", uuid: id, message: { role: "user", content: "Repeated widget input" } }
    : { type: "response_item", payload: { type: "message", turn_id: id, role: "user", content: [{ type: "input_text", text: "Repeated widget input" }] } });
  const first = user("synthetic-first"), second = user("synthetic-second");
  try {
    fs.writeFileSync(file, prefix + first + "\n" + second + "\n");
    const cursor = nativeHookCursor(file, engine, "synthetic-first");
    expect(cursor.offset).toBe(Buffer.byteLength(prefix));
    expect(cursor.key).toBe(`native:${messageTextDigest(first)}`);
    expect(nativeOccurrenceAfter(file, engine, cursor.offset, cursor.digest)?.key).toBe(cursor.key);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
