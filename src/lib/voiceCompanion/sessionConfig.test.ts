import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { BACKEND_INSTRUCTIONS, backendRequest, COMPANION_TOOLS, LIVE_API_VERSION, LIVE_BACKEND_MODEL, LIVE_MODEL, liveSessionConfiguration, PROTOTYPE_BACKEND_RULES, PROTOTYPE_LIVE_RULES } from "./sessionConfig";
import { z } from "zod";
import { VOICE_ASK_MAX_CHARS } from "./liveGate";
import { codexVoiceThread } from "./codexProvider";

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
    "list_tasks", "get_task", "list_pipelines", "get_pipeline", "agent_activity", "conversation_messages", "orchestrator_messages", "search_transcripts", "read_prototype_review", "view_prototype_frame",
    "agent_fleet", "get_orchestrator", "list_projects", "relay_owner_history", "orchestrator_reports", "reread_orchestrator_report", "request_orchestrator_delegation", "resolve_orchestrator_confirmation", "end_conversation",
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
    expect(BACKEND_INSTRUCTIONS).toContain("at most three short sentences");
    expect(BACKEND_INSTRUCTIONS).not.toMatch(/tap alone|sends nothing; the operator/);
    expect(config.client.data_channel.allowed_client_events).toEqual([]);
    expect(backendRequest([]).tools.every(tool => tool.parameters.additionalProperties === false)).toBe(true);
  }
});

test("the backend answers from reads, composes one complete task, names a waiting request instead of sending it again, and keeps report facts with their subjects", () => {
  expect(BACKEND_INSTRUCTIONS).toContain("Answer from the reads whatever the board, the orchestrator's messages and its reports already hold");
  expect(BACKEND_INSTRUCTIONS).toContain("send only work, or a question the reads cannot answer");
  expect(BACKEND_INSTRUCTIONS).toContain("A question about what the voice can do is answered from the registry and never sent");
  expect(BACKEND_INSTRUCTIONS).toContain("Write every send yourself, in your own words, as one complete task");
  expect(BACKEND_INSTRUCTIONS).toContain("independent requests are separate tasks");
  expect(BACKEND_INSTRUCTIONS).toContain("passes its handle as pending_request and nothing is sent");
  expect(BACKEND_INSTRUCTIONS).toContain("a request still waiting for its report is not sent again");
  expect(BACKEND_INSTRUCTIONS).toContain("set asked_again, and it is sent again even while its report is pending");
  expect(BACKEND_INSTRUCTIONS).toContain("pass the repeat with its handle and send only the new part as its own ask");
  expect(BACKEND_INSTRUCTIONS).toContain("Pass project only when the operator named another project; never invent one");
  expect(BACKEND_INSTRUCTIONS).toContain("keep each fact with its own subject and in the report's words");
  expect(BACKEND_INSTRUCTIONS).toContain("call reread_orchestrator_report: the report is read from its own text, so never retell it");
  for (const locale of ["en", "uk"] as const) {
    const instructions = liveSessionConfiguration(locale).instructions;
    expect(instructions).toContain("answer from this list in plain words; that needs no delegation");
    expect(instructions).toContain("the backend says whether its answer is still on the way, and sends it again only when they explicitly ask to send it once more");
    expect(instructions).toContain("read its lines as written, in order, in every part");
    expect(instructions).toContain("never merge, reorder, swap or add facts");
  }
  // The last response of a delegation turns tools off, so what was read is answered.
  expect(backendRequest([]).tool_choice).toBe("auto");
  expect(backendRequest([], { final: true }).tool_choice).toBe("none");
});

test("the Codex thread carries the same backend rules and the call's reports read", () => {
  const thread = codexVoiceThread("/fixture");
  expect(thread.developerInstructions).toContain("whose answer is in this thread");
  expect(thread.developerInstructions).not.toContain("whose answer is under Reads earlier in this call");
  expect(thread.developerInstructions).toContain("passes its handle as pending_request and nothing is sent");
  expect(thread.developerInstructions).toContain(`at most ${VOICE_ASK_MAX_CHARS} characters`);
  expect(thread.dynamicTools.map(tool => tool.name)).toContain("orchestrator_reports");
});

test("both voice paths require prototype evidence and stop reading on a hand-off", () => {
  for (const instructions of [BACKEND_INSTRUCTIONS, codexVoiceThread("/fixture").developerInstructions]) {
    expect(instructions).toContain(PROTOTYPE_BACKEND_RULES);
    expect(instructions).toContain("State a prototype detail only when a read in this call returned it.");
    expect(instructions).toContain("Say what a frame shows only when view_prototype_frame returned that frame to you in this call");
    expect(instructions).toContain("call no read or search tool: send one task you write from what this call already holds");
    expect(instructions).toContain("A spoken choice records no decision");
  }
  for (const locale of ["uk", "en"] as const) {
    const instructions = liveSessionConfiguration(locale).instructions;
    expect(instructions).toContain(PROTOTYPE_LIVE_RULES);
    expect(instructions).toContain("you never see prototype pictures yourself; the backend looks at them");
    expect(instructions).toContain("delegate once, and say it was passed on only when the backend says so");
    expect(instructions).toContain("never say what you are about to look at, read or send");
  }
});


test("Telegram history reads directly and never hands private content to the orchestrator", () => {
  for (const locale of ["en", "uk"] as const) {
    expect(liveSessionConfiguration(locale).instructions).toContain("Telegram groups");
    expect(liveSessionConfiguration(locale).instructions).toContain("Celestia or a clone");
  }
  expect(BACKEND_INSTRUCTIONS).toContain("read relay_owner_history directly");
  expect(BACKEND_INSTRUCTIONS).toContain("Do not send history questions to the orchestrator");
  expect(BACKEND_INSTRUCTIONS).toContain("Never put message text, names, usernames, chat titles or chat ids");
});


test("composed tasks carry project scope, provenance and interface language in both backend paths", () => {
  const send = COMPANION_TOOLS.find(tool => tool.name === "request_orchestrator_delegation")!;
  for (const locale of ["uk", "en"] as const) {
    const language = `The operator's interface language is ${locale === "uk" ? "Ukrainian" : "English"}.`;
    for (const instructions of [backendRequest([], { locale }).instructions, codexVoiceThread("/fixture", true, "Call memory", locale).developerInstructions]) {
      expect(instructions).toContain(language);
      expect(instructions).toContain("Write every send yourself, in your own words, as one complete task");
      expect(instructions).toContain("Never send the transcript or the operator's raw phrasing as the task");
      expect(instructions).toContain("what to do and why, the outcome the operator expects");
      expect(instructions).toContain("card, pull request, issue, project or earlier point");
      expect(instructions).toContain("add no step, requirement, constraint, priority, deadline or suggestion of your own");
      expect(instructions).toContain("earlier turns only resolve what it refers to");
      expect(instructions).toContain("even when the operator asks to send it");
      expect(instructions).toContain("riddles, poems");
      expect(instructions).toContain("at most one sentence, on a last line that names it as theirs");
      expect(instructions).toContain("when you could not resolve a referent, say so in the task and never guess it");
      expect(instructions).not.toMatch(/in the operator's words and language|never translate it|send one ask in their words|operator's words\/language/);
    }
    expect(liveSessionConfiguration(locale).instructions).toContain("When the backend says a request is not work for the orchestrator, nothing was sent: answer it yourself when you can.");
  }
  expect(send.description).toContain("Write the instruction yourself, in your own words, as one complete task");
  expect(send.description).toContain("General knowledge, chit-chat and content the voice can give itself are never sent");
  expect(send.description).toContain("Never pass the transcript or the operator's raw phrasing as the task");
  expect(send.description).toContain("operator's interface language unless they asked for another");
  expect(send.description).not.toContain("in their own words and language");
  expect(send.parameters.properties.instruction.maxLength).toBe(6000);
  expect(VOICE_ASK_MAX_CHARS).toBe(4000);
});

test("voice design docs describe the current composition rule and contain no copied-phrasing directive", () => {
  const docs = [
    readFileSync(new URL("../../../docs/design/voice-lean-delegation.md", import.meta.url), "utf8"),
    readFileSync(new URL("../../../docs/design/voice-prototype-review-flow.md", import.meta.url), "utf8"),
  ];
  for (const document of docs) {
    expect(document).toContain("4,000 Unicode scalars");
    expect(document).toContain("own words");
    expect(document).not.toMatch(/send one ask in their words|in the operator's words and language|operator's words\/language|never translate it|shared 400-Unicode-scalar limit/i);
  }
});
