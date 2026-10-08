import { expect, test } from "bun:test";

import { relayMessageText, splitRelayMessageText } from "./relayText";

test("a relay reads back as its source project and the handoff's own words", () => {
  const body = "Please check the release.\n\nSecond paragraph.";
  expect(splitRelayMessageText(relayMessageText(body, "docs.site"))).toEqual({ project: "docs.site", body });
});

test("text that only resembles a relay stays whole", () => {
  expect(splitRelayMessageText("Relay from the orchestrator of project Atlas. Please check.")).toBeNull();
  expect(splitRelayMessageText("Please check the release.")).toBeNull();
});
