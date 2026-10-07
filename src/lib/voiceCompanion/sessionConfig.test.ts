import { expect, test } from "bun:test";
import { BACKEND_INSTRUCTIONS, backendRequest, COMPANION_TOOLS, LIVE_API_VERSION, LIVE_BACKEND_MODEL, LIVE_MODEL, liveSessionConfiguration } from "./sessionConfig";
import { z } from "zod";

// Official DataChannelConfigParam / ServerEventSelectorParam, verified on
// 2026-10-06. Response wrappers require the nested selector; other events forbid it.
const selectorSchema = z.object({ type: z.string(), response_event: z.string().optional() }).strict()
  .refine(value => value.type === "response.event" ? !!value.response_event : value.response_event === undefined);

test("the frontend event permissions conform to the official Live server selector schema", () => {
  expect(z.array(selectorSchema).safeParse(liveSessionConfiguration("en").client.data_channel.allowed_server_events).success).toBe(true);
});

test("the frontend data channel receives no provider event: the server's cleaned projection is the page's only text", () => {
  // allowed_server_events selects what Live sends to the frontend; an empty
  // array allows none (official create schema). session.closed carries the
  // whole session, instructions and input included, so it is not allowed either.
  expect(liveSessionConfiguration("en").client.data_channel.allowed_server_events).toEqual([]);
});

test("Live delegates to this server, which runs the backend itself with the registry tools", () => {
  expect(liveSessionConfiguration("uk").delegation).toEqual({ type: "client" });
  const request = backendRequest([{ role: "user", content: "context" }]);
  expect(request).toMatchObject({ model: LIVE_BACKEND_MODEL, store: false, parallel_tool_calls: false, max_output_tokens: 512, service_tier: "default", reasoning: { effort: "none" } });
  expect(request.tools.map(tool => tool.name)).toEqual(COMPANION_TOOLS.map(tool => tool.name));
});

test("the Live configuration exposes the explicit read allowlist and the delegation tools with calm speech instructions", () => {
  expect(LIVE_API_VERSION).toBe("v1/live");
  expect(LIVE_MODEL).toBe("gpt-live-1");
  expect(COMPANION_TOOLS.map(tool => tool.name)).toEqual([
    "list_tasks", "get_task", "list_pipelines", "get_pipeline", "agent_activity", "conversation_messages", "request_orchestrator_delegation", "resolve_orchestrator_confirmation", "end_conversation",
  ]);
  for (const locale of ["en", "uk"] as const) {
    const config = liveSessionConfiguration(locale);
    expect(config.store).toBe(false);
    expect(config.instructions).toContain("short spoken summary with an offer to go deeper");
    expect(config.instructions).toContain("short pauses");
    // Hands-free by default; asking first is the exception and is answered aloud.
    expect(config.instructions).toContain("confirms nothing by default");
    expect(config.instructions).toContain("critical or hard to undo");
    expect(config.instructions).toContain("delegate their spoken yes or no");
    expect(config.instructions).not.toMatch(/Send tap|Spoken confirmation is disabled/);
    expect(BACKEND_INSTRUCTIONS).toContain("your judgment alone");
    expect(BACKEND_INSTRUCTIONS).not.toMatch(/tap alone|sends nothing; the operator/);
    expect(config.client.data_channel.allowed_client_events).toEqual([]);
    expect(backendRequest([]).tools.every(tool => tool.parameters.additionalProperties === false)).toBe(true);
  }
});
