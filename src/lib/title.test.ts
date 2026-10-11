import { expect, test } from "bun:test";

import { derivedSpawnTitle, durableSemanticTitle, isGenericSessionTitle, semanticTitle } from "./title";

test("spawn titles derive from the role and a sixty-character first prompt line", () => {
  const firstLine = "Implement the durable conversation identity migration with exact evidence";

  expect(derivedSpawnTitle("builder", `${firstLine}\nIgnore this second line`)).toBe(
    `builder · ${firstLine.slice(0, 59).trimEnd()}…`,
  );
});

test("spawn titles skip leading empty and formatting-only prompt lines", () => {
  for (const prefix of ["---\n", "\n***\r\n>\r\n", "###\n```markdown\n"]) {
    expect(derivedSpawnTitle("architect", `${prefix}Inspect export retry ownership.\nReport the unsafe transitions.`))
      .toBe("architect · Inspect export retry ownership.");
  }
  expect(derivedSpawnTitle("architect", "---\n***\n")).toBe("architect · New task");
});

test("legacy engine placeholders have no semantic title value", () => {
  for (const placeholder of [
    "Codex session",
    "Claude session",
    "Codex",
    "Claude",
    "Codex session.",
    "Claude session!",
    "(Codex session)",
    "— Claude —",
    "Codex-session",
    "Claude/session",
    "Codex · session",
    "Claude: session",
    "Codex_session",
    "Claude_session",
    "Codex*session",
    "Claude#session",
    "Codex>session",
    "Claude~session",
  ]) {
    expect(isGenericSessionTitle(placeholder)).toBeTrue();
    expect(durableSemanticTitle(placeholder)).toBeNull();
    expect(semanticTitle(placeholder)).toBeNull();
  }
  expect(semanticTitle("Implement registry identity")).toBe("Implement registry identity");
  expect(durableSemanticTitle("Review issue #913")).toBe("Review issue #913");
  expect(durableSemanticTitle("Codex session migration")).toBe("Codex session migration");
});

test("punctuation-only values are not durable semantic titles", () => {
  for (const value of ["###", "***", "~~~", ">>>", "---", "...", "!!!", "()", "[]"]) {
    expect(durableSemanticTitle(value)).toBeNull();
    expect(semanticTitle(value)).toBeNull();
  }
});
