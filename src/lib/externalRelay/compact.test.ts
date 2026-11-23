import { test, expect } from "bun:test";
import fs from "node:fs";
import { compactRequestSchema, requestSchema } from "./protocol";
import { checkedCompactCompletion, runCompactRequest } from "./compact";
import { startTestRelay } from "./testRelay";
import { readAnswerRecord } from "./answers";
import type { PairedRelay } from "./store";
const fixture = (name: string) => JSON.parse(fs.readFileSync(`${import.meta.dir}/fixtures/relay_v1/${name}.json`, "utf8"));
test("X3 compact claims replay", () => {
  for (const role of ["owner", "admin"]) {
    const raw = fixture(`claimed_compact_${role}`).request;
    expect(compactRequestSchema.safeParse(raw).success).toBe(true);
    expect(requestSchema.safeParse(raw).success).toBe(false);
  }
});
test("every service X3 completion acceptance and refusal", () => {
  const samples = fixture("compact_completions");
  for (const body of Object.values(samples.valid)) expect(checkedCompactCompletion(body) as unknown).toEqual(body);
  for (const sample of Object.values(samples.rejected) as {kind: string; body: unknown}[])
    expect(checkedCompactCompletion(sample.body, sample.kind)).toBeNull();
});

test("compact refusals retain the sanitized service diagnostic", async () => {
  const service = await startTestRelay(() => ({ status: 400, body: { error: { code: "malformed", reason: "invalid_answer", message: "private parser input" } } }));
  const request = compactRequestSchema.parse(fixture("claimed_compact_owner").request);
  const relay = { id: "compact_fixture", api_base: `${service.origin}/v1`, credential: "fixture", targets: [], limits: { max_response_bytes: 1048576 } } as unknown as PairedRelay;
  try {
    await runCompactRequest(relay, request);
    expect(readAnswerRecord(relay.id, request.target_id, request.request_id)).toMatchObject({
      delivery: "refused", completionRefusals: [{ status: 400, code: "malformed", reason: "invalid_answer" }],
    });
  } finally { await service.close(); }
});
