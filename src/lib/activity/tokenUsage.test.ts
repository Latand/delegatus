import { expect, test } from "bun:test";
import { TranscriptLineReader } from "./transcriptExport";
import { claudeUsage, codexMeta, codexUsage, usageCounts, USAGE_AT } from "./tokenUsage.fixture";

function reader(rows: unknown[], previous?: TranscriptLineReader) {
  const out = new TranscriptLineReader(previous?.state, true);
  for (const row of rows) out.acceptBytes(Buffer.from(JSON.stringify(row)));
  return out;
}
test("Claude blocks fold by id with maximum counters; synthetic and unrelated records add nothing", () => {
  const rows = [claudeUsage("response-a"), claudeUsage("response-a", USAGE_AT, 2), claudeUsage("response-a")];
  const synthetic = claudeUsage("synthetic"); synthetic.message.model = "<synthetic>";
  const got = reader([...rows, synthetic, { type: "system", subtype: "compact_boundary", timestamp: USAGE_AT }]);
  expect(got.usage!.records).toHaveLength(1);
  expect(got.usage!.records[0].counts).toEqual(usageCounts(2));
});
test("Codex model, thread and record preference survive piece boundaries", () => {
  const first = reader([codexMeta("thread-a"), { timestamp: USAGE_AT, type: "turn_context", payload: { model: "model-a" } }]);
  const second = reader([codexUsage("thread-a")], first);
  expect(second.usage!.records[0]).toMatchObject({ model: "model-a", id: "thread-a", counts: { ...usageCounts(), cacheWrite1h: 0 } });
  const third = reader([codexUsage("thread-a", 120, USAGE_AT, true)], second);
  expect(third.usage!.records).toEqual([]);
});
test("legacy first event retains the fork baseline and never stores last usage as a sum", () => {
  const got = reader([codexMeta("fork"), codexUsage("fork", 1200, USAGE_AT, true)]);
  expect(got.usage!.records[0]).toMatchObject({ legacy: true, baseline: { total: 1080, input: 900, cached: 720 }, cumulative: { total: 1200 } });
});
test("malformed usage is diagnosed and subset counters are clamped", () => {
  const invalid = claudeUsage("invalid"); invalid.message.usage.input_tokens = -1; invalid.message.usage.output_tokens_details.thinking_tokens = 1000;
  const timestamp = claudeUsage("bad-date"); timestamp.timestamp = "invalid";
  const got = reader([invalid, timestamp]);
  expect(got.usage!.malformed).toBe(2);
  expect(got.usage!.records[0].counts).toMatchObject({ input: 0, reasoning: 20 });
});
