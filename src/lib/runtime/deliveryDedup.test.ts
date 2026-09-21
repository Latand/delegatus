import { createHash } from "node:crypto";

import { describe, expect, test } from "bun:test";

import { deliveryDedupToken, sha256Hex } from "./deliveryDedup";

/* The hash exists in this repository twice on purpose — the host stamps the
   marker on the server, the feed recognises it in a browser that has neither
   `node:crypto` nor a secure context — so the ONE thing that matters is that
   the two answers are the same string. Anything that drifts here unbinds every
   row from the submission it belongs to, silently. */
describe("delivery dedup token", () => {
  const reference = (value: string) => createHash("sha256").update(value).digest("hex");

  test("agrees with node:crypto on the shapes an operation id takes", () => {
    const ids = [
      "",
      "a",
      "operation-evidence-key",
      "op_01JKX9V2Q8N4M6R0T3W7Y5B2C1",
      "operation-" + "9".repeat(55),
      /* 55, 56 and 64 bytes are the padding's own boundaries: the block that
         has just enough room for the length, the one that does not, and the
         one that is exactly full. */
      "x".repeat(55),
      "x".repeat(56),
      "x".repeat(64),
      "x".repeat(119),
      "x".repeat(1000),
      /* Non-ASCII is hashed over its UTF-8 bytes, like every other consumer. */
      "операція-із-кирилицею",
      "🛰️-operation",
    ];
    for (const id of ids) expect(sha256Hex(id)).toBe(reference(id));
  });

  test("the token is that digest, in the marker's own lowercase hex", () => {
    const id = "operation-one-message-one-row";
    expect(deliveryDedupToken(id)).toBe(reference(id));
    expect(deliveryDedupToken(id)).toMatch(/^[a-f0-9]{64}$/);
  });
});
