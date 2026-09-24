import { expect, test } from "bun:test";

import {
  NATIVE_INJECT_CAPABILITY,
  NATIVE_QUEUE_CAPABILITY,
  NATIVE_TURN_PROFILE_CAPABILITY,
} from "./codexCapabilityFlags";
import { blockingHostActivityFlags, isHostCapabilityFlag, NATIVE_MULTI_AGENT_DENY_FLAG } from "./hostActivityFlags";
import { STRUCTURED_IMAGE_CAPABILITY } from "./structuredContent";

/* One case per advertisement a host is known to carry. Each is set for the
   host's whole life, so reading any one as activity refuses retirement of every
   host that carries it (#747, #2137). */
test.each([
  ["the structured image capability every Claude, Codex and Copilot host advertises", STRUCTURED_IMAGE_CAPABILITY],
  ["the denied-tool set of a host launched without native multi-agent tools", NATIVE_MULTI_AGENT_DENY_FLAG],
  ["a denied-tool set whose tool list has changed", "native-multi-agent-deny:Task"],
  ["the Codex app-server's native queue", NATIVE_QUEUE_CAPABILITY],
  ["the Codex app-server's injection support", NATIVE_INJECT_CAPABILITY],
  ["the Codex app-server's per-turn profile", NATIVE_TURN_PROFILE_CAPABILITY],
])("%s is a capability, not activity", (_name, flag) => {
  expect(isHostCapabilityFlag(flag)).toBe(true);
  expect(blockingHostActivityFlags([flag])).toEqual([]);
});

test("the Codex advertisements are the literal strings the live registry records", () => {
  /* The measured flag set of #2137, spelled out: a rename on either side would
     silently put every Codex host back behind no-active-flags. */
  expect([NATIVE_QUEUE_CAPABILITY, NATIVE_INJECT_CAPABILITY, NATIVE_TURN_PROFILE_CAPABILITY])
    .toEqual(["native-queue", "native-inject", "native-turn-profile"]);
});

/* The app-server's own thread flags (ThreadActiveFlag in its protocol schema)
   say the thread is blocked on the operator; anything unnamed is unknown, and
   unknown is never idle. */
test.each([
  ["a Codex thread waiting on an approval", "waitingOnApproval"],
  ["a Codex thread waiting on user input", "waitingOnUserInput"],
  ["an activity flag", "compacting"],
  ["an advertisement a later release adds before it is named", "some-future-capability-v9"],
  ["a flag that only shares a prefix with an exact advertisement", `${NATIVE_QUEUE_CAPABILITY}-v2`],
])("%s blocks", (_name, flag) => {
  expect(isHostCapabilityFlag(flag)).toBe(false);
  expect(blockingHostActivityFlags([flag])).toEqual([flag]);
});

test("the measured Codex flag set leaves nothing blocking, and activity beside it still blocks", () => {
  const measured = [STRUCTURED_IMAGE_CAPABILITY, "native-queue", "native-inject", "native-turn-profile"];
  expect(blockingHostActivityFlags(measured)).toEqual([]);
  expect(blockingHostActivityFlags([...measured, "waitingOnApproval"])).toEqual(["waitingOnApproval"]);
});
