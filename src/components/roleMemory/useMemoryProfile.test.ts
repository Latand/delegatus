import { expect, test } from "bun:test";
import { readProfileStream } from "./useMemoryProfile";
import { profileView } from "@/lib/memory/profile";
import { sampleMemory } from "@/lib/memory/profile.fixture";

test("stream snapshots survive split UTF-8 and line boundaries", async () => {
  const view = { ...profileView(sampleMemory(), "uk", "haiku", null), model: "Зразок" };
  const bytes = new TextEncoder().encode(JSON.stringify(view) + "\n" + JSON.stringify(view));
  const stream = new ReadableStream<Uint8Array>({ start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); } });
  const results: unknown[] = [];
  await readProfileStream(stream, value => results.push(value));
  expect(results).toEqual([view, view]);
});
