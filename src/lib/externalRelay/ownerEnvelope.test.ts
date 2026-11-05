import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { accountManager } from "@/lib/accounts/manager";
import { assertStructuredTextEnvelope, MAX_STRUCTURED_TEXT_BYTES, StructuredEnvelopeTooLargeError } from "@/lib/runtime/structuredContent";
import { contextRequest } from "./request.fixture";
import { requestSchema, type ExternalRelayCompletion } from "./protocol";
import { ownerTierFor } from "./profile";
import { ownerContinuationPrompt, ownerFailureAnswer, ownerInitialCursor, ownerRunPrompt, runOwnerAgent } from "./ownerRun";
import { json } from "./prompt";
import { quotedRelayText } from "./promptBudget";
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
function request(text = "answer: amber. " + "я😀".repeat(6000) + " end: violet.") {
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

for (const kind of ["fresh", "resumed", "local", "report"] as const)
test(`oversized ${kind} context preserves the quotation's ends and current instruction`, () => {
  const r = request();
  const owner = ownerTierFor(target, r)!;
  if (kind === "local") owner.localContext = { resolution: "explicit_parent", questionIds: ["quote"], origins: { quote: "agent" }, conversation: r.input.conversation };
  if (kind === "report") owner.bridgeReport = { project: "project-b", sourceSeat: "seat-b", reportId: "report-b", reportText: r.input.conversation[0]!.text };
  const original = JSON.stringify({ r, owner });
  const prompt = kind === "resumed" ? ownerContinuationPrompt(r, owner, 1, { seen: [], staticDigest: null }).prompt : ownerRunPrompt(r, owner, 1);
  assertStructuredTextEnvelope(prompt);
  expect(prompt).toContain("answer: amber."); expect(prompt).toContain("end: violet.");
  expect(prompt).toContain("[Quoted text shortened; beginning and end kept]");
  expect(prompt).not.toContain("�");
  expect(section(prompt, "owner_request")).toMatchObject({ text: owner.text, request_text: owner.requestText });
  expect(JSON.stringify({ r, owner })).toBe(original);
  const cursor = kind === "resumed" ? ownerContinuationPrompt(r, owner, 1, { seen: [], staticDigest: null }) : ownerInitialCursor(r, owner, 1);
  expect(cursor.seen).not.toContain("quote");
  if (kind === "report") expect(section(prompt, "bridge_report")).toMatchObject({ project: "project-b", sourceSeat: "seat-b", reportId: "report-b" });
});

test("escaping is budgeted after rendering and a later reply can receive a shortened quote again", () => {
  const r = request("answer: amber. " + "<\\\"😀".repeat(2000) + " end: violet.");
  const owner = ownerTierFor(target, r)!;
  const first = ownerContinuationPrompt(r, owner, 1, { seen: [], staticDigest: null });
  assertStructuredTextEnvelope(first.prompt);
  expect(first.seen).not.toContain("quote");
  const next = ownerContinuationPrompt(r, owner, 1, { seen: first.seen, staticDigest: first.digest });
  assertStructuredTextEnvelope(next.prompt);
  expect(next.prompt).toContain("answer: amber.");
  expect(next.prompt).toContain("end: violet.");
});

test("small quotations remain complete, and excerpt boundaries are valid UTF-8", () => {
  for (const text of ["plain", "ї😀".repeat(1000), "<\\\"".repeat(1000)]) {
    if (Buffer.byteLength(text) <= 512) expect(quotedRelayText(text, 512)).toBe(text);
    else {
      const excerpt = quotedRelayText(text, 512);
      expect(Buffer.byteLength(excerpt)).toBeLessThanOrEqual(512);
      expect(excerpt).not.toContain("�");
      expect(excerpt).toContain("[Quoted text shortened;");
    }
  }
});

for (const language of ["en", "uk"] as const)
test(`unfit mandatory input has an actionable ${language} failure without internal diagnostics`, () => {
  const r = request(); r.input.conversation[1]!.text = language === "uk" ? "Виконай " + "я😀".repeat(6000) : "Do " + "😀".repeat(9000);
  const owner = ownerTierFor(target, r)!;
  expect(() => ownerRunPrompt(r, owner, 1)).toThrow(StructuredEnvelopeTooLargeError);
  for (const max of [4000, 20]) {
    r.answer.max_chars = max;
    const answer = ownerFailureAnswer(r, owner, ownerTurnDiagnostic("launch", new StructuredEnvelopeTooLargeError()))!;
    expect(answer.text).toContain(language === "uk" ? "Скоротіть" : "Shorten");
    expect(answer.text).not.toContain("StructuredEnvelope"); expect(answer.text).not.toContain("try again");
    expect(answer.reply_to).toBe(owner.messageId);
  }
});

for (const desiredBytes of [32000, 32004])
test(`real completion route answers a multibyte first message at ${desiredBytes} bytes before clipping`, async () => {
  const account = spyOn(accountManager, "resolveHeadlessSpawn").mockReturnValue({ kind: "available", account: {
    engine: "codex", accountId: "fixture", kind: "managed", home: root, transcriptRoot: root, env: { ...process.env },
  } });
  fs.writeFileSync(path.join(root, "auth.json"), "{}");
  fs.writeFileSync(path.join(root, "models_cache.json"), JSON.stringify({ models: [{ slug: "gpt-6-sol" }] }));
  const completions: ExternalRelayCompletion[] = [];
  const server = await startTestRelay((req, body) => {
    if (req.url?.endsWith("/complete")) completions.push(body as ExternalRelayCompletion);
    return { body: { status: "ok" } };
  });
  const paired = pairedRelay(server.origin);
  updateRelayStore(store => ({ ...store, relays: [paired] }));
  let launches = 0, quoted = "", captured = "";
  const r = request("answer: amber. " + "😀".repeat(5000) + " end: violet.");
  const runtime = { leaseWorker: false, ownerPorts: {
    launch: async (body: Record<string, unknown>) => {
      launches++;
      captured = String(body.prompt); assertStructuredTextEnvelope(captured);
      quoted = JSON.stringify(section(captured, "owner_reply_context"));
      return { status: 202, body: { conversationId: "conversation_envelope", initialMessage: "delivered" } };
    },
    observe: async () => ({ state: "ended" as const, finalText: quoted.includes("amber") && quoted.includes("violet") ? "The two answers are amber and violet." : "Missing context" }),
    stop: async () => {}, noExecution: async () => true, pollMs: 1,
  } };
  try {
    // Calibrate through the same route, including its attachment/context suffix.
    // ASCII service context sets the exact byte boundary around a multibyte
    // quotation without changing its excerpt or the current owner's request.
    await runClaimedRequest(paired, { ...r, request_id: "rq_calibration" }, undefined, runtime);
    expect(launches).toBe(1);
    const initialPrompt = captured;
    const initialInstructions = json(r.input.instructions);
    r.input.instructions += "x".repeat(desiredBytes - Buffer.byteLength(captured));
    const raw = initialPrompt.replace(`<service_instructions>\n${initialInstructions}\n</service_instructions>`,
      `<service_instructions>\n${json(r.input.instructions)}\n</service_instructions>`);
    expect(Buffer.byteLength(raw)).toBe(desiredBytes);
    launches = 0; completions.length = 0;
    const result = await runClaimedRequest(paired, r, undefined, runtime);
    expect(result).toMatchObject({ outcome: "answered", answer: { reply_to: "m1", text: "The two answers are amber and violet." } });
    expect(launches).toBe(1); expect(completions).toHaveLength(1);
    if (desiredBytes === MAX_STRUCTURED_TEXT_BYTES) expect(Buffer.byteLength(captured)).toBe(desiredBytes);
    else expect(captured).toContain("[Quoted text shortened;");
    expect(quoted).toContain("answer: amber."); expect(quoted).toContain("end: violet.");
    expect(completions[0]).toMatchObject({ outcome: "answered", answer: { text: "The two answers are amber and violet." } });
  } finally { account.mockRestore(); await server.close(); }
});


test("resumed dispatch keeps its complete base when optional inbound context cannot fit", async () => {
  const r = request("A short quotation"); const owner = ownerTierFor(target, r)!;
  const base = ownerContinuationPrompt(r, owner, 1, { seen: [], staticDigest: null }).prompt.padEnd(MAX_STRUCTURED_TEXT_BYTES, "\n");
  let sent = "", launches = 0;
  const result = await runOwnerAgent({ request: r, owner, target: { ...target }, accountId: null, hardCapMs: 2000,
    continuation: { conversationId: "conversation_suffix", prompt: base }, inboundContext: "😀".repeat(10000), onConversation: () => {},
    ports: { launch: async () => { launches++; return { status: 500, body: {} }; },
      continue: async (turn, prompt, _target, authorize) => {
        authorize(); sent = prompt;
        assertStructuredTextEnvelope(prompt);
        return { ok: true, structured: true, target: turn.conversationId!, outcome: "held", operationId: turn.clientAttemptId };
      }, observe: async () => ({ state: "ended", finalText: "The answer is ready." }), stop: async () => {}, pollMs: 1 },
  }).done;
  expect(result).toMatchObject({ status: "done", answer: { text: "The answer is ready." } });
  expect(launches).toBe(0); expect(sent).toBe(base);
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


test("local metadata follows retained rows while an ambiguous choice stays ambiguous", () => {
  const r = request("Short parent"); const owner = ownerTierFor(target, r)!;
  const rows = Array.from({ length: 190 }, (_, i) => ({ ...r.input.conversation[0]!, id: `local_${i}_${"q".repeat(50)}`, text: "Previous assistant question?" }));
  owner.localContext = { resolution: "ambiguous", questionIds: rows.map(m => m.id),
    origins: Object.fromEntries(rows.map(m => [m.id, "agent" as const])), conversation: [...rows, ...r.input.conversation] };
  const prompt = ownerRunPrompt(r, owner, 1);
  assertStructuredTextEnvelope(prompt);
  const metadata = section(prompt, "local_outbound_context") as { resolution: string; question_ids: string[]; origins: Record<string, string> };
  const messages = section(prompt, "conversation") as { id: string }[];
  const retained = new Set(messages.map(m => m.id));
  expect(metadata.resolution).toBe("ambiguous");
  expect(metadata.question_ids.length).toBeLessThan(rows.length);
  expect(metadata.question_ids.every(id => retained.has(id))).toBe(true);
  expect(Object.keys(metadata.origins).every(id => retained.has(id))).toBe(true);
});
