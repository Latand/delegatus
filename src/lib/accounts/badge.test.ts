import { expect, test } from "bun:test";

import { accountIdFromPath, DEFAULT_ACCOUNT_ID } from "./badge";

test("reads the managed Claude account id from a transcript path", () => {
  expect(
    accountIdFromPath("/fixture-user/.config/agent-log-viewer/accounts/claude/claude-fixture/projects/-x/session.jsonl"),
  ).toBe("claude-fixture");
});

test("reads the managed Codex account id from a session path", () => {
  expect(
    accountIdFromPath("/fixture-user/.config/agent-log-viewer/accounts/codex/codex-fixture/sessions/2026/07/x.jsonl"),
  ).toBe("codex-fixture");
});

test("reads the managed Copilot account id from a transcript path", () => {
  expect(accountIdFromPath("/fixture/config/agent-log-viewer/accounts/copilot/managed-one/session-state/session/events.jsonl"))
    .toBe("managed-one");
});

test("the legacy home (no accounts segment) maps to the default account", () => {
  expect(accountIdFromPath("/fixture-user/.claude/projects/-x/session.jsonl")).toBe(DEFAULT_ACCOUNT_ID);
  expect(accountIdFromPath("/fixture-user/.codex/sessions/2026/07/x.jsonl")).toBe(DEFAULT_ACCOUNT_ID);
});

test("missing/empty path falls back to the default account", () => {
  expect(accountIdFromPath(null)).toBe(DEFAULT_ACCOUNT_ID);
  expect(accountIdFromPath(undefined)).toBe(DEFAULT_ACCOUNT_ID);
  expect(accountIdFromPath("")).toBe(DEFAULT_ACCOUNT_ID);
});

test("a foreign engine folder under accounts is not matched", () => {
  expect(accountIdFromPath("/x/accounts/gemini/acct/projects/s.jsonl")).toBe(DEFAULT_ACCOUNT_ID);
});
