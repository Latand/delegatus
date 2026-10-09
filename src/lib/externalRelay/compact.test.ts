import { test, expect } from "bun:test";
import fs from "node:fs";
import { compactRequestSchema, requestSchema, ownerApiSchema, ownerApiMeSchema, descriptorSchema } from "./protocol";
import { checkedCompactCompletion } from "./compact";
const fixture = (name: string) => JSON.parse(fs.readFileSync(`${import.meta.dir}/fixtures/relay_v1/${name}.json`, "utf8"));
test("X3 compact claims and owner discovery replay", () => {
  for (const role of ["owner", "admin"]) {
    const raw = fixture(`claimed_compact_${role}`).request;
    expect(compactRequestSchema.safeParse(raw).success).toBe(true);
    expect(requestSchema.safeParse(raw).success).toBe(false);
  }
  const descriptor = fixture("descriptor_owner_api");
  const old = { ...descriptor }; delete old.owner_api; delete old.features;
  expect(descriptorSchema.parse(descriptor)).toEqual(descriptorSchema.parse(old));
  expect(ownerApiSchema.parse(fixture("descriptor_owner_api")).owner_api.operations.length).toBeGreaterThan(0);
  for (const value of [...Object.values(fixture("owner_api_me")), { user_id: 41 }]) expect(ownerApiMeSchema.safeParse(value).success).toBe(true);
});
test("every service X3 completion acceptance and refusal", () => {
  const samples = fixture("compact_completions");
  for (const body of Object.values(samples.valid)) expect(checkedCompactCompletion(body) as unknown).toEqual(body);
  for (const sample of Object.values(samples.rejected) as {kind: string; body: unknown}[])
    expect(checkedCompactCompletion(sample.body, sample.kind)).toBeNull();
});
