import { expect, test } from "bun:test";
import { COMPANION_TOOLS, LIVE_API_VERSION, LIVE_MODEL, liveSessionConfiguration } from "./sessionConfig";
import { z } from "zod";

// Official DataChannelConfigParam / ServerEventSelectorParam, verified on
// 2026-10-06. Response wrappers require the nested selector; other events forbid it.
const selectorSchema = z.object({ type: z.string(), response_event: z.string().optional() }).strict()
  .refine(value => value.type === "response.event" ? !!value.response_event : value.response_event === undefined);

test("the frontend event permissions conform to the official Live server selector schema", () => {
  expect(z.array(selectorSchema).safeParse(liveSessionConfiguration("en").client.data_channel.allowed_server_events).success).toBe(true);
});

test("the Live configuration exposes the explicit read allowlist and proposal with calm speech instructions", () => {
  expect(LIVE_API_VERSION).toBe("v1/live");
  expect(LIVE_MODEL).toBe("gpt-live-1");
  expect(COMPANION_TOOLS.map(tool => tool.name)).toEqual([
    "list_tasks", "get_task", "list_pipelines", "get_pipeline", "agent_activity", "conversation_messages", "request_orchestrator_delegation",
  ]);
  for (const locale of ["en", "uk"] as const) {
    const config = liveSessionConfiguration(locale);
    expect(config.store).toBe(false);
    expect(config.instructions).toContain("short spoken summary with an offer to go deeper");
    expect(config.instructions).toContain("short pauses");
    expect(config.instructions).toContain("Spoken confirmation is disabled");
    expect(config.client.data_channel.allowed_client_events).toEqual([]);
    expect(config.delegation.responses.tools.every(tool => tool.parameters.additionalProperties === false)).toBe(true);
  }
});
