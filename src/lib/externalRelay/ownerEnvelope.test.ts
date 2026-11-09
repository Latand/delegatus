import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountManager } from "@/lib/accounts/manager";
import { assertStructuredTextEnvelope, MAX_STRUCTURED_TEXT_BYTES } from "@/lib/runtime/structuredContent";
import { contextRequest } from "./request.fixture";
import { requestSchema, type ExternalRelayCompletion } from "./protocol";
import { ownerTierFor } from "./profile";
import { ownerContinuationPrompt, ownerFailureAnswer, ownerRunPrompt, runOwnerAgent } from "./ownerRun";
import { json } from "./prompt";
import { RelayMandatoryPromptTooLargeError } from "./promptBudget";
import { richRequest } from "./rich.fixture";
import { prepareOwnerPrompt } from "./ownerRun";
import { ownerTurnDiagnostic } from "./diagnostic";
import { runClaimedRequest } from "./runner";
import { updateRelayStore, type PairedRelay } from "./store";
import { startTestRelay } from "./testRelay";

const at = "2026-11-05T12:00:00.000Z";
const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-envelope-"));
let caseNumber = 0;
const target = { id: "target_1", name: "Target", answered_by: "install", fallback: "service", enabled: true,
  engine: "codex", model: "gpt-6-sol", effort: "low", project: null, concurrency: 1, hardCapMinutes: 1, ownerTier: true } as const;

function pairedRelay(origin: string): PairedRelay {
  return { id: "relay_envelope", origin: origin, api_base: origin + "/v1", name: "Test", description: "Test",
    credential: "x".repeat(43), owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null },
    pairedAt: at, paused: false, limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 }, targets: [{ ...target }] };
}
beforeEach(() => { process.env.LLV_STATE_DIR = path.join(root, `case-${++caseNumber}`); });
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
function request(text = "Short parent") {
  return requestSchema.parse({ ...contextRequest, request_id: "rq_envelope", claimed_at: at,
    answer: { max_chars: 4000, progress: "none" }, input: { ...contextRequest.input,
      requester: { ...contextRequest.input.requester, is_owner: true }, short_term_memory: null, tools: [],
      conversation: [
        { ...contextRequest.input.conversation[0], id: "quote", text, author: { key: "assistant", name: "Assistant", self: true } },
        { ...contextRequest.input.conversation[0], text: "Read the beginning and end of my quoted message", reply_to: "quote" },
      ],
    },
  });
}
function section(prompt: string, name: string): unknown {
  return JSON.parse(prompt.match(new RegExp(`<${name}>\\n([^]*?)\\n</${name}>`))![1]!);
}
function toolRows(prompt: string): Array<Record<string, unknown>> {
  const index = section(prompt, "tools") as Array<Record<string, unknown>> | { columns: string[]; rows: unknown[][] };
  return Array.isArray(index) ? index : index.rows.map(row => Object.fromEntries(index.columns.map((key, i) => [key, row[i]])));
}

for (const mode of ["fresh", "resumed"] as const)
test(`${mode} prompt reduces escaped tool summaries by rendered size and retains tool contracts`, () => {
  const r = request("A short quoted message");
  r.input.tools = Array.from({ length: 50 }, (_, index) => ({ name: `read_${index}`,
    summary: "😀".repeat(60) + "<".repeat(120), mode: "direct" as const, effect: "read" as const, audience: "owner" as const }));
  const owner = ownerTierFor(target, r)!;
  const prompt = mode === "fresh" ? ownerRunPrompt(r, owner, 1)
    : ownerContinuationPrompt(r, owner, 1, { seen: [], staticDigest: null }).prompt;
  assertStructuredTextEnvelope(prompt);
  const tools = toolRows(prompt);
  expect(tools).toHaveLength(50);
  expect(tools.map(tool => tool.name)).toEqual(r.input.tools.map(tool => tool.name));
  expect(tools.every(tool => tool.mode === "direct" && tool.effect === "read" && tool.audience === "owner")).toBe(true);
  expect(section(prompt, "owner_request")).toMatchObject({ text: owner.text, request_text: owner.requestText });
});

for (const mode of ["fresh", "resumed"] as const)
test(`${mode} prompt keeps the requested bridge-report fact ahead of unrelated memory`, () => {
  const r = request("What is MIDDLE_FIELD?");
  r.input.short_term_memory = "unrelated memory ".repeat(1500);
  const owner = ownerTierFor(target, r)!;
  owner.bridgeReport = { project: "project-b", sourceSeat: "seat-b", reportId: "report-b",
    reportText: "L".repeat(1400) + " MIDDLE_FIELD=amber " + "R".repeat(1555) };
  const prompt = mode === "fresh" ? ownerRunPrompt(r, owner, 1)
    : ownerContinuationPrompt(r, owner, 1, { seen: [], staticDigest: null }).prompt;
  assertStructuredTextEnvelope(prompt);
  expect(section(prompt, "bridge_report")).toMatchObject({ project: "project-b", sourceSeat: "seat-b", reportId: "report-b" });
  expect(section(prompt, "bridge_report")).toMatchObject({ reportText: owner.bridgeReport!.reportText });
  expect(prompt).not.toContain("unrelated memory");
  if (mode === "resumed") expect(section(prompt, "short_term_memory")).toBeNull();
});

test("a mandatory-size refusal reaches the completion route and replay after restart does not launch or answer twice", async () => {
  const account = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture", kind: "managed", home: root, transcriptRoot: root, env: { ...process.env },
  } });
  const completions: ExternalRelayCompletion[] = [];
  const service = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/complete")) completions.push(body as ExternalRelayCompletion);
    return { body: { status: "ok" } };
  });
  const paired = pairedRelay(service.origin);
  updateRelayStore(store => ({ ...store, relays: [paired] }));
  const r = request("Short parent");
  r.input.conversation[1]!.text = "Виконай " + "😀".repeat(9000);
  let launches = 0;
  try {
    const runtime = { leaseWorker: false, ownerPorts: {
      launch: async () => { launches++; return { status: 500, body: {} }; },
      observe: async () => ({ state: "failed" as const }), stop: async () => {}, noExecution: async () => true, pollMs: 1,
    } };
    const result = await runClaimedRequest(paired, r, undefined, runtime);
    expect(result).toMatchObject({ outcome: "answered", answer: { reply_to: "m1", text: expect.stringContaining("Скоротіть") } });
    expect(launches).toBe(0); expect(completions).toHaveLength(1);
    expect(JSON.stringify(completions)).not.toContain("StructuredEnvelopeTooLargeError");
    await runClaimedRequest(paired, r, undefined, runtime);
    expect(launches).toBe(0); expect(completions).toHaveLength(1);
    const file = path.join(process.env.LLV_STATE_DIR!, "replay.json");
    fs.writeFileSync(file, JSON.stringify({ relay: paired, request: r, phase: "complete-now", epoch: Date.now(), finalText: "Unexpected second answer" }), { mode: 0o600 });
    const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "ownerLifecycle.fixture.ts"), file],
      { env: { ...process.env }, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    const timeout = setTimeout(() => child.kill("SIGTERM"), 15000);
    try {
      const [code, output, errors] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
      expect(code, errors).toBe(0);
      expect(output).not.toContain("fixture-launch:");
      expect(output).toContain("fixture-result:");
      expect(completions).toHaveLength(1);
    } finally { clearTimeout(timeout); }
  } finally { account.mockRestore(); await service.close(); }
});



for (const mode of ["fresh", "resumed"] as const) {
  const compose = (r: ReturnType<typeof request>, owner = ownerTierFor(target, r)!, suffix: string | { mandatory?: string; optional?: string } = "") => mode === "fresh"
    ? prepareOwnerPrompt(r, owner, 1, suffix) : ownerContinuationPrompt(r, owner, 1, { seen: [], staticDigest: null }, suffix);

  for (const kind of ["direct", "report"] as const)
  test(`${mode} ${kind} requested middle fact takes priority over optional inbound suffix`, () => {
    // The terminal review's four-case probe. Full direct quote/report fits
    // without the unrelated suffix, including its middle requested field.
    const text = kind === "report" ? "я".repeat(6500) + " REQUESTED_FIELD=amber " + "ю".repeat(6500)
      : "я".repeat(5750) + " REQUESTED_FIELD=amber " + "ю".repeat(5750);
    const r = request(kind === "direct" ? text : "Short quoted report");
    r.input.conversation[1]!.text = "What is REQUESTED_FIELD?";
    if (kind === "direct") r.input.instructions += "s".repeat(1100);
    const owner = ownerTierFor(target, r)!;
    if (kind === "report") owner.bridgeReport = { project: "project-b", sourceSeat: "seat-b", reportId: "report-b", reportText: text };
    const base = compose(r, owner);
    const suffix = "UNRELATED_INBOUND " + "x".repeat(4050);
    expect(Buffer.byteLength(base.prompt)).toBeLessThanOrEqual(MAX_STRUCTURED_TEXT_BYTES);
    expect(Buffer.byteLength(base.prompt + "\n" + suffix)).toBeGreaterThan(MAX_STRUCTURED_TEXT_BYTES);
    const withSuffix = compose(r, owner, suffix);
    assertStructuredTextEnvelope(withSuffix.prompt);
    expect(withSuffix).toEqual(base);
    expect(withSuffix.prompt).toContain("REQUESTED_FIELD=amber");
    expect(withSuffix.prompt.match(/REQUESTED_FIELD=amber/g)).toHaveLength(1);
  });

  test(`${mode} measures the exact escaped envelope boundary without shortening mandatory text`, () => {
    const r = request(`я😀 <quoted> \\ " details`);
    const owner = ownerTierFor(target, r)!;
    const base = compose(r, owner);
    r.input.instructions += "x".repeat(MAX_STRUCTURED_TEXT_BYTES - Buffer.byteLength(base.prompt));
    const exact = compose(r, owner, "optional");
    expect(Buffer.byteLength(exact.prompt)).toBe(MAX_STRUCTURED_TEXT_BYTES);
    expect(section(exact.prompt, "service_instructions")).toBe(r.input.instructions);
    r.input.instructions += "x";
    expect(() => compose(r, owner)).toThrow(RelayMandatoryPromptTooLargeError);
  });

  for (const conversationBytes of [47353, 45186])
  test(`${mode} measured ${conversationBytes}-byte history, 80 tools and 15 KB instructions launch within bound`, async () => {
    const r = request("Requested fact: amber. " + "я".repeat(1100));
    r.input.conversation[1]!.text = "Which fact is in the quoted message?";
    const old = Array.from({ length: 38 }, (_, i) => ({ ...r.input.conversation[0]!, id: `old-${i}`, text: "x".repeat(850) }));
    r.input.conversation.unshift(...old);
    const delta = conversationBytes - Buffer.byteLength(json(r.input.conversation));
    expect(delta).toBeGreaterThan(0);
    old[0]!.text += "x".repeat(delta);
    expect(Buffer.byteLength(json(r.input.conversation))).toBe(conversationBytes);
    r.input.instructions = "s".repeat(3025);
    r.input.owner_instructions = "o".repeat(15017);
    const rich = richRequest();
    r.features = rich.features;
    r.input.format = { ...rich.input.format!, guide: "" };
    r.input.format.guide = "g".repeat(1486 - Buffer.byteLength(json(r.input.format)));
    expect(Buffer.byteLength(json(r.input.format))).toBe(1486);
    r.input.short_term_memory = "m".repeat(2544);
    r.input.tools = Array.from({ length: 80 }, (_, i) => ({ name: `read_${i}`, summary: "<".repeat(100),
      mode: "direct" as const, effect: "read" as const, audience: "owner" as const, parameters: { type: "object", properties: {} } }));
    const original = JSON.stringify(r);
    const owner = ownerTierFor(target, r)!;
    const prepared = compose(r, owner);
    const messages = section(prepared.prompt, "conversation") as { id: string; text?: string }[];
    expect(prepared.prompt).toContain("Requested fact: amber.");
    expect(prepared.prompt.match(/Requested fact: amber\./g)).toHaveLength(1);
    expect(section(prepared.prompt, "owner_instructions")).toBe(r.input.owner_instructions);
    expect(section(prepared.prompt, "service_instructions")).toBe(r.input.instructions);
    expect(toolRows(prepared.prompt)).toHaveLength(80);
    expect(prepared.seen).toContain("quote");
    expect(prepared.seen).not.toContain("old-0");
    expect(messages.find(m => m.id === "quote")!.text).toBe(r.input.conversation.at(-2)!.text);
    let sent = "", launches = 0, continues = 0;
    const result = await runOwnerAgent({ request: r, owner, target: { ...target }, accountId: null, hardCapMs: 2000,
      preparedPrompt: prepared, ...(mode === "resumed" ? { continuation: { conversationId: "conversation_measured", prompt: prepared.prompt } } : {}),
      onConversation: () => {}, ports: {
        launch: async body => { launches++; sent = String(body.prompt); return { status: 202, body: { conversationId: "conversation_measured", initialMessage: "delivered" } }; },
        continue: async (turn, prompt, _target, authorize) => { authorize(); continues++; sent = prompt;
          return { ok: true, structured: true, target: turn.conversationId!, outcome: "delivered", operationId: turn.clientAttemptId }; },
        observe: async () => ({ state: "ended", finalText: "The requested fact is amber." }), stop: async () => {}, pollMs: 1,
      } }).done;
    expect(result.status).toBe("done");
    expect(launches).toBe(mode === "fresh" ? 1 : 0); expect(continues).toBe(mode === "resumed" ? 1 : 0);
    expect(sent).toBe(prepared.prompt); assertStructuredTextEnvelope(sent);
    console.info("measured relay prompt", { mode, conversationBytes, promptBytes: Buffer.byteLength(sent) });
    expect(JSON.stringify(r)).toBe(original);
  });

  for (const kind of ["quote", "report", "intent", "service", "owner", "document", "media"] as const)
  test(`${mode} oversized mandatory ${kind} refuses without truncation or dispatch`, async () => {
    const r = request(); const huge = "<я\\\"".repeat(3500);
    if (kind === "quote") r.input.conversation[0]!.text = huge;
    if (kind === "intent") r.input.conversation[1]!.text = huge;
    if (kind === "service") r.input.instructions = huge;
    if (kind === "owner") r.input.owner_instructions = huge;
    if (kind === "document") r.input.documents = [{ title: "notes", text: huge, message_id: "quote" }];
    const owner = ownerTierFor(target, r)!;
    if (kind === "report") owner.bridgeReport = { project: "project-b", sourceSeat: "seat-b", reportId: "report-b", reportText: huge };
    const original = JSON.stringify({ r, owner });
    expect(() => compose(r, owner, { mandatory: kind === "media" ? huge.repeat(2) : "" })).toThrow(RelayMandatoryPromptTooLargeError);
    expect(JSON.stringify({ r, owner })).toBe(original);
  });

  test(`${mode} required media manifest survives optional suffix and does not become tool metadata`, () => {
    const r = request("Parent attachment");
    const mandatory = '<inbound_media> [{"ref":"media-fixture","local_path":"./media/notes.txt"}] </inbound_media>';
    const result = compose(r, undefined, { mandatory, optional: "x".repeat(32000) });
    expect(result.prompt).toContain(mandatory); assertStructuredTextEnvelope(result.prompt);
    expect(result.prompt).not.toContain("x".repeat(32000));
  });
}

for (const language of ["en", "uk"] as const)
test(`mandatory refusal has a readable ${language} answer and numeric diagnostic`, () => {
  const r = request(); r.input.conversation[1]!.text = language === "uk" ? "Поясни" : "Explain";
  const owner = ownerTierFor(target, r)!;
  const diagnostic = ownerTurnDiagnostic("launch", new RelayMandatoryPromptTooLargeError(32001));
  expect(diagnostic.promptBudget).toEqual({ kind: "mandatory_core_too_large", mandatoryBytes: 32001, limitBytes: 32000 });
  for (const max of [4000, 20]) {
    r.answer.max_chars = max;
    const answer = ownerFailureAnswer(r, owner, diagnostic)!;
    expect(answer.reply_to).toBe(owner.messageId);
    expect(answer.text).toContain(language === "uk" ? "Скоротіть" : "Shorten");
    expect(answer.text).not.toContain("StructuredEnvelope");
  }
  const shortStatuses = language === "uk" ? ["Виконано", "невідомий", "підтвердження", "минув"]
    : ["Done", "unknown", "Confirm", "expired"];
  for (const [index, priorAction] of (["completed", "unknown", "confirmation_pending", "confirmation_expired"] as const).entries()) {
    const withOutcome = { ...diagnostic, promptBudget: { ...diagnostic.promptBudget!, priorAction } };
    const answer = ownerFailureAnswer(r, owner, withOutcome)!;
    expect(Array.from(answer.text).length).toBeLessThanOrEqual(20);
    expect(answer.text).toContain(shortStatuses[index]!);
  }
});

for (const status of ["ok", "outcome_unknown", "confirmation_pending"] as const)
test(`Cloud size refusal preserves the prior ${status} action and does not dispatch another turn`, async () => {
  let posts = 0, cloud = 0, launches = 0;
  const service = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/tool-calls")) {
      posts++;
      const call = body as { call_id: string; tool: string };
      return { body: { call_id: call.call_id, tool: call.tool, status, output: "<".repeat(6000), truncated: false,
        effect: "action", delivered: false, replayed: false, calls_remaining: 15,
        ...(status === "confirmation_pending" ? { confirmation_id: "fixture-confirmation", expires_at: "2099-01-01T00:00:00Z" } : {}) } };
    }
    return { body: { status: "ok" } };
  });
  const paired = pairedRelay(service.origin);
  paired.targets[0] = { ...target, engine: "codex-cloud", project: "fixture-project", cloudEnvironmentId: "answer-env" };
  updateRelayStore(store => ({ ...store, relays: [paired] }));
  const r = request(); r.request_id = `size-after-${status}`;
  r.input.conversation[1]!.text = "Write the requested note";
  r.input.tools = [{ name: "write_note", summary: "Write a note", mode: "direct", effect: "action",
    parameters: { type: "object", properties: {} } }];
  try {
    const result = await runClaimedRequest(paired, r, undefined, { leaseWorker: false,
      cloudTransport: async () => { cloud++; return JSON.stringify({ action: "call", text: "", reply_to: null,
        calls: [{ tool: "write_note", arguments: "{}", cursor: null }] }); },
      ownerPorts: { launch: async () => { launches++; throw new Error("unexpected local fallback"); },
        observe: async () => ({ state: "failed" }), stop: async () => {} },
    });
    const outcome = status === "ok" ? "completed" : status === "outcome_unknown" ? "unknown" : "confirmation_pending";
    const answerText = result?.outcome === "answered" ? result.answer.text : "";
    expect(result?.outcome).toBe("answered");
    expect(answerText).toContain("Shorten");
    expect(answerText).toContain(status === "ok" ? "action completed"
      : status === "outcome_unknown" ? "outcome is unknown" : "awaits confirmation");
    const { readAnswerRecord } = await import("./answers");
    expect(readAnswerRecord(paired.id, r.target_id, r.request_id)).toMatchObject({ diagnostic: { promptBudget: { priorAction: outcome } } });
    expect({ posts, cloud, launches }).toEqual({ posts: 1, cloud: 1, launches: 0 });
  } finally { await service.close(); }
});
