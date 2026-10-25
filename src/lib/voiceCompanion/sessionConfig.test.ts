import { expect, test } from "bun:test";

import { BACKEND_INSTRUCTIONS, backendRequest, COMPANION_TOOLS, LIVE_API_VERSION, LIVE_BACKEND_MODEL, LIVE_MODEL, liveSessionConfiguration, PROTOTYPE_BACKEND_RULES, PROTOTYPE_LIVE_RULES } from "./sessionConfig";
import { z } from "zod";
import { VOICE_ASK_MAX_CHARS } from "./liveGate";
import { codexVoiceStart, codexVoiceThread } from "./codexProvider";

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
  expect(request).toMatchObject({ model: LIVE_BACKEND_MODEL, store: false, parallel_tool_calls: false, max_output_tokens: 2048, service_tier: "default", reasoning: { effort: "none" } });
  expect(request.tools.map(tool => tool.name)).toEqual(COMPANION_TOOLS.map(tool => tool.name));
});

test("the Live configuration exposes the explicit read allowlist and the delegation tools with calm speech instructions", () => {
  expect(LIVE_API_VERSION).toBe("v1/live");
  expect(LIVE_MODEL).toBe("gpt-live-1");
  expect(COMPANION_TOOLS.map(tool => tool.name)).toEqual([
    "list_tasks", "get_task", "list_pipelines", "get_pipeline", "agent_activity", "conversation_messages", "orchestrator_messages", "orchestrator_actions", "search_transcripts", "read_prototype_review", "view_prototype_frame",
    "agent_fleet", "get_orchestrator", "list_projects", "show_orchestrator_message", "relay_owner_history", "orchestrator_reports", "reread_orchestrator_report", "request_orchestrator_delegation", "resolve_orchestrator_confirmation", "end_conversation",
  ]);
  for (const locale of ["en", "uk"] as const) {
    const config = liveSessionConfiguration(locale);
    expect(config.store).toBe(false);
    expect(config.client.data_channel.allowed_client_events).toEqual([]);
    expect(backendRequest([]).tools.every(tool => tool.parameters.additionalProperties === false)).toBe(true);
  }
});

test("the backend answers from reads, composes one complete task, names a waiting request instead of sending it again, and keeps report facts with their subjects", () => {
  // The last response of a delegation turns tools off, so what was read is answered.
  expect(backendRequest([]).tool_choice).toBe("auto");
  expect(backendRequest([], { final: true }).tool_choice).toBe("none");
});

test("the Codex thread carries the same backend rules and the call's reports read", () => {
  const thread = codexVoiceThread("/fixture");
  expect(thread.dynamicTools.map(tool => tool.name)).toContain("orchestrator_reports");
});

test("both voice paths require prototype evidence and stop reading on a hand-off", () => {
  for (const instructions of [BACKEND_INSTRUCTIONS, codexVoiceThread("/fixture").developerInstructions]) {
    expect(instructions).toContain(PROTOTYPE_BACKEND_RULES);
  }
  for (const locale of ["uk", "en"] as const) {
    const instructions = liveSessionConfiguration(locale).instructions;
    expect(instructions).toContain(PROTOTYPE_LIVE_RULES);
  }
});

test("composed tasks carry project scope, provenance and interface language in both backend paths", () => {
  const send = COMPANION_TOOLS.find(tool => tool.name === "request_orchestrator_delegation")!;
  for (const locale of ["uk", "en"] as const) {
    const language = `The operator's interface language is ${locale === "uk" ? "Ukrainian" : "English"}.`;
    for (const instructions of [backendRequest([], { locale }).instructions, codexVoiceThread("/fixture", true, "Call memory", locale).developerInstructions]) {
      expect(instructions).toContain(language);
    }
  }
  expect(send.parameters.properties.instruction.maxLength).toBe(6000);
  expect(VOICE_ASK_MAX_CHARS).toBe(4000);
});

test("both native voice transports receive the shared speech language restriction", () => {
  for (const locale of ["uk", "en"] as const) {
    expect(liveSessionConfiguration(locale).instructions).toContain("Speech recognition languages: uk, ru, en.");
    expect(codexVoiceStart("fixture", locale, "v=0").prompt).toContain("Speech recognition languages: uk, ru, en.");
  }
});
