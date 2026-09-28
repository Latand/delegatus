import { expect, test } from "bun:test";

import { parseTelegramChatReference } from "./chatReference";

test("parses chat IDs, usernames, private and public topic links", () => {
  expect(parseTelegramChatReference("-1002470529049")).toEqual({ chat: "-1002470529049" });
  expect(parseTelegramChatReference("@project_reports")).toEqual({ chat: "@project_reports" });
  expect(parseTelegramChatReference("t.me/project_reports")).toEqual({ chat: "@project_reports" });
  expect(parseTelegramChatReference("https://t.me/c/2470529049/51865")).toEqual({ chat: "-1002470529049", topicId: 51865 });
  expect(parseTelegramChatReference("https://t.me/c/2470529049/51865/99")).toEqual({ chat: "-1002470529049", topicId: 51865 });
  expect(parseTelegramChatReference("t.me/project_reports/51865")).toEqual({ chat: "@project_reports", topicId: 51865 });
  expect(parseTelegramChatReference("t.me/project_reports/51865/99")).toEqual({ chat: "@project_reports", topicId: 51865 });
});

test("rejects malformed and nonpositive topic references", () => {
  for (const value of ["", "t.me/c/abc/5", "t.me/c/123/0", "t.me/group/0", "https://elsewhere.test/group/5", "t.me/group/5/nope"]) {
    expect(parseTelegramChatReference(value)).toBeNull();
  }
});
