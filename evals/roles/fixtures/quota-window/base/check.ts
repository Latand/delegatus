import assert from "node:assert/strict";
import fs from "node:fs";
import { quotaSummary } from "./case/quotaSummary";
for (const vector of JSON.parse(fs.readFileSync(new URL("./public.json", import.meta.url), "utf8"))) {
  const input=structuredClone(vector.input);
  if(input.text?.syntheticToken)input.text="sk-"+"z".repeat(22);
  const before=JSON.stringify(input);
  assert.deepEqual(quotaSummary(input),vector.expected,vector.name);
  assert.equal(JSON.stringify(input),before,"input mutated");
}
console.log("Public behavioral checks passed");
