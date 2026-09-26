import { expect, test } from "bun:test";

import { fmtAge, fmtAgeSeconds } from "./utils";

test("unknown project activity does not render a NaN relative age", () => {
  expect(fmtAge(Number.NaN)).toBe("");
  expect(fmtAge(0)).toBe("");
  expect(fmtAgeSeconds(Number.NaN)).toBe("");
});
