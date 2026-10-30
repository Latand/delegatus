import { expect, test } from "bun:test";
import { parseRemovalResult, REMOVAL_RESULT_PREFIX } from "./removalProtocol";

test("account removal result survives incidental diagnostics before and after it", () => {
  const frame = { ok: true, result: {
    archive: "fixture-archive", cleanupPending: false, files: 17, bytes: 120,
    conversationsRewritten: 2, pinsCleared: 1, deliveriesDropped: 0, migrationsSettled: 0,
  } } satisfies ReturnType<typeof parseRemovalResult>;
  expect(parseRemovalResult(`[state lease] cleared abandoned accounts\n${REMOVAL_RESULT_PREFIX}${JSON.stringify(frame)}\nshutdown diagnostic\n`)).toEqual(frame);
});

test("account removal refuses missing or conflicting completion frames", () => {
  expect(() => parseRemovalResult('{"ok":true}\n')).toThrow("invalid result");
  const line = REMOVAL_RESULT_PREFIX + '{"ok":true}\n';
  expect(() => parseRemovalResult(line + line)).toThrow("invalid result");
});
