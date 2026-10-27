import { expect, test } from "bun:test";

import { conversationModelLabel, fmtAge, fmtAgeSeconds } from "./utils";

test("unknown project activity does not render a NaN relative age", () => {
  expect(fmtAge(Number.NaN)).toBe("");
  expect(fmtAge(0)).toBe("");
  expect(fmtAgeSeconds(Number.NaN)).toBe("");
});

test("a conversation header names the observed model, else the launch's, else nothing", () => {
  expect(conversationModelLabel({ engine: "codex", model: "gpt-6-astra", launchModel: "gpt-6-luna" })).toBe("gpt-6-astra");
  expect(conversationModelLabel({ engine: "codex", model: null, launchModel: "gpt-6-luna" })).toBe("gpt-6-luna");
  expect(conversationModelLabel({ engine: "claude", model: null, launchModel: "opus" })).toBe("Opus 5.5");
  expect(conversationModelLabel({ engine: "claude", model: "opus-4-1", launchModel: "opus" })).toBe("Opus 4.1");
  expect(conversationModelLabel({ engine: "codex", model: null, launchModel: null })).toBeNull();
});
