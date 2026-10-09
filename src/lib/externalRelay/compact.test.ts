import { test, expect } from "bun:test";
import fs from "node:fs";
import { compactRequestSchema, requestSchema } from "./protocol";
import { checkedCompactCompletion } from "./compact";
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
