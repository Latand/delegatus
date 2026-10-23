import { updateOperatorSettings } from "@/lib/operator/settings";
import { resolvePrototypeReviewId } from "@/lib/prototypeReview/store";
import { shortId } from "@/lib/shortIds";
import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { NextRequest } from "next/server";
import { soloBrowserSession } from "@/lib/agent/operatorSession";

import { VIEWER_SPAWN_CAPABILITY_ENV } from "@/lib/agent/spawnPolicy";
import type { PublicDenyList } from "@/lib/bridge/publicSafe";
import { ForgeAppWriteRefused } from "@/lib/forge/appWrite";
import { ISSUE_REPORT_QUESTION_ID, issueReportApprovalForm, issueReportApprovalReplies } from "@/lib/issueReports/approvalForm";
import { issueReportDigest, readIssueReportPreview, recordIssueReportPreview } from "@/lib/issueReports/store";
import { decidePrototype } from "@/lib/prototypeReview/decision";
import { resetPrototypeDeliveryWorkerForTests, settlePrototypeDeliveriesForTests } from "@/lib/prototypeReview/deliveryWorker";
import { decisionsPOST, publishPOST, reviewScopePOST } from "@/lib/prototypeReview/http";
import { clearSeatRoundsForTests, loadSeatRounds } from "@/lib/prototypeReview/seatRounds";
import type { DecidePrototypeInput, PrototypeQuestion } from "@/lib/prototypeReview/types";
import { prototypeWorld, type PrototypeWorld } from "@/lib/prototypeReview/world";

import { viewerMcpBindings, viewerMcpToolPolicy, type CallerAttribution } from "./bindings";
import { createMcpToolService, createViewerMcpServer, MemoryMcpReceiptStore, MCP_TOOL_NAMES, MUTATING_MCP_TOOL_NAMES, TOOL_INPUT_SCHEMAS, type McpToolResult } from "./server";

/*
 * #2518 at the tool boundary: detector hints accompany the agent judgment.
 * What is filed is the stored preview the operator approved, named by its
 * digest, and the approval is the operator's choice in the decision form the
 * seat asked with publish_prototype_review. The form goes through the real
 * publication and decision routes; nothing here files an issue: the publisher
 * is a fake that records what it was handed.
 */

let sandbox = "";
let privacyState = "";
let previousState: string | undefined;
let previousCapability: string | undefined;

beforeEach(async () => {

  privacyState = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-privacy-sources-"));
  previousState = process.env.LLV_STATE_DIR;
  previousCapability = process.env[VIEWER_SPAWN_CAPABILITY_ENV];
  process.env.LLV_STATE_DIR = privacyState;
  sandbox = path.join(privacyState, "issue-reports"); fs.mkdirSync(sandbox);
  /* The seat's own capability; the fake Viewer below names the caller itself. */
  process.env[VIEWER_SPAWN_CAPABILITY_ENV] = "a".repeat(43);
  await resetPrototypeDeliveryWorkerForTests();
  clearSeatRoundsForTests();
});
afterEach(async () => {
  await resetPrototypeDeliveryWorkerForTests();
  const { shutdownTaskPageWorker } = await import("@/lib/links/taskPageWorker");
  await shutdownTaskPageWorker();
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  if (previousCapability === undefined) delete process.env[VIEWER_SPAWN_CAPABILITY_ENV];
  else process.env[VIEWER_SPAWN_CAPABILITY_ENV] = previousCapability;
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(privacyState, { recursive: true, force: true });
});

const PROJECT = "repo-report";
const SEAT = "conversation_seat";
const SEAT_CALLER: CallerAttribution = { kind: "manager", conversationId: SEAT, role: "orchestrator" };
const OTHER_SEAT = "conversation_other_seat";
const OTHER_SEAT_CALLER: CallerAttribution = { kind: "manager", conversationId: OTHER_SEAT, role: "orchestrator" };
const REPORTER: CallerAttribution = { kind: "agent", conversationId: "conversation_reporter", role: "issue-reporter" };
const DEPUTY: CallerAttribution = { kind: "manager", conversationId: SEAT, role: "orchestrator", via: { deputy: "conversation_deputy" } };
const DENY: PublicDenyList = { accounts: ["claude-main-b"], people: [], local: [], projects: [] };
const REPOSITORY = "example/delegatus";
const ISSUE_URL = `https://${["github", "com"].join(".")}/${REPOSITORY}/issues/4242`;

const JUDGMENT = {
  assessment: "I reviewed the whole report and judge it suitable for publication.",
  removed: "Removed machine and account details from the evidence.",
  harmlessHints: "The technical error quotation is harmless because it describes tool output.",
  uncertainties: "None after reviewing the whole text.",
};

const REPORT = {
  title: "send_message answers delivered while the recipient never receives it",
  body: [
    "## Symptom", "send_message answered delivered and the recipient's turn never started.",
    "## Observed evidence", "message_receipt answered state delivered; agent_activity showed no new record for ten minutes.",
    "## Impact", "A reviewer stage waited on a message that never arrived.",
    "## Expected behaviour", "The receipt says queued until the recipient reads the message.",
    "## Suggested investigation", "The settlement path in src/lib/mcp/bindings.ts.",
  ].join("\n"),
};

type Publisher = (report: { title: string; body: string }, repository: string) => Promise<string>;
type ApprovalForm = { title: string; questions: PrototypeQuestion[] };

function request(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, { method: "POST", headers: { cookie: `llv_operator=${soloBrowserSession()}`, host: "localhost", "sec-fetch-site": "same-origin" }, body: JSON.stringify(body) });
}

/* The operator's answers, as the form's question takes them. */
const YES = { answers: [{ questionId: ISSUE_REPORT_QUESTION_ID, options: [0] }] };
const EDIT_FIRST = { answers: [{ questionId: ISSUE_REPORT_QUESTION_ID, options: [1] }] };
const NO = { answers: [{ questionId: ISSUE_REPORT_QUESTION_ID, options: [2] }] };

function harness(options: { publisher?: Publisher; finder?: (report: { title: string; body: string }) => Promise<string | null>; deny?: PublicDenyList; privacyRead?: () => Promise<void>; controlRead?: (url: string) => Promise<Record<string, unknown>>; locale?: "en" | "uk" } = {}) {
  updateOperatorSettings({ locale: options.locale ?? "en", source: "chosen" });
  const published: { title: string; body: string; repository: string }[] = [];
  /* Every caller gets its own service and receipt store, as every agent has
     its own MCP server process over the one state directory. */
  const as = (caller: CallerAttribution) => {
    const domain = {
      attentionAuthority: () => (caller.conversationId
        ? { kind: "worker", conversationId: caller.conversationId, role: caller.role }
        : { kind: "unidentified" }),
      callerAttribution: () => caller,
      publicDenyList: options.privacyRead || options.controlRead ? undefined : () => options.deny ?? DENY,
      viewerProjects: () => [PROJECT],
      issueReportsDir: () => sandbox,
      issueReportRepository: () => REPOSITORY,
      operatorLocale: () => options.locale ?? "en",
      issueReportFinder: async (report: { title: string; body: string }) => (options.finder ? options.finder(report) : null),
      issueReportPublisher: async (report: { title: string; body: string }, repository: string) => {
        published.push({ ...report, repository });
        return options.publisher ? options.publisher(report, repository) : ISSUE_URL;
      },
    };
    /* The Viewer's own prototype routes, with the caller as the project's seat. */
    const world: PrototypeWorld = { ...prototypeWorld, caller: () => ({ conversationId: caller.conversationId, project: PROJECT }), stage: () => null, orchestrator: () => caller.conversationId };
    const control = {
      post: async (url: string, body: Record<string, unknown>) => {
        const route = url === "/api/prototype-reviews" ? publishPOST : url === "/api/prototype-reviews/scope" ? reviewScopePOST : null;
        if (!route) throw new Error(`unexpected control mutation ${url}`);
        const response = await route(request(url, body), world);
        const answer = await response.json() as Record<string, unknown>;
        if (!response.ok) throw new Error(String(answer.error));
        return answer;
      },
      get: async (url: string) => {
        if (options.controlRead) return options.controlRead(url);
        expect(url).toBe("/api/telegram/bot/agent?op=chats&includeInactive=1");
        await options.privacyRead?.();
        return { chats: [] };
      },
    };
    return createMcpToolService(viewerMcpBindings(undefined, control, domain as never), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(domain as never));
  };
  let next = 0;
  const call = (caller: CallerAttribution, args: Record<string, unknown>) =>
    as(caller).callTool("issue_report", { clientRequestId: `issue-report-${next += 1}`, ...(args.action === "preview" ? { privacyJudgment: JUDGMENT } : {}), ...args }) as Promise<McpToolResult & Record<string, unknown>>;
  /** The seat reads the preview back and asks the operator in the form show
      answers, or in the form given; the answer is the form's review id. */
  const asks = async (digest: string, seat = SEAT_CALLER, form?: ApprovalForm): Promise<string> => {
    const shown = await call(seat, { action: "show", digest });
    expect(shown.ok).toBe(true);
    const asked = await as(seat).callTool("publish_prototype_review", { clientRequestId: `form-${next += 1}`, ...(form ?? shown.approvalForm as ApprovalForm) }) as McpToolResult & Record<string, unknown>;
    expect(asked).toMatchObject({ ok: true, taskId: null });
    return resolvePrototypeReviewId(loadSeatRounds(), asked.reviewId as string)!;
  };
  /** The operator answers the form in Delegatus, through the decision route. */
  const decides = async (reviewId: string, answer: Partial<DecidePrototypeInput> = YES) => {
    reviewId = resolvePrototypeReviewId(loadSeatRounds(), reviewId)!;
    const delivery = { recover: async () => null, send: async () => ({ state: "sent" as const }), retry: async () => ({ state: "sent" as const }) };
    const operator: PrototypeWorld = { ...prototypeWorld, orchestrator: () => loadSeatRounds().find((round) => round.id === reviewId)?.source.conversationId ?? null };
    const response = await decisionsPOST(request("/api/projects/decisions", { project: PROJECT, reviewId, chosen: [], comment: "", ...answer }), operator, delivery);
    await settlePrototypeDeliveriesForTests();
    expect(response.status).toBe(200);
  };
  /** The seat asks, and the operator chooses the approving option. */
  const approves = async (digest: string, seat = SEAT_CALLER) => decides(await asks(digest, seat));
  return { as, call, published, asks, decides, approves };
}

async function previewed(h: ReturnType<typeof harness>, report = REPORT): Promise<string> {
  const preview = await h.call(REPORTER, { action: "preview", ...report });
  expect(preview.ok).toBe(true);
  expect(preview.digest).toBe(shortId(issueReportDigest(report)));
  return issueReportDigest(report);
}

/** The next millisecond: a form is after a reading only by the clock. */
function tick(): void {
  const from = Date.now();
  while (Date.now() === from) { /* wait */ }
}

test("the tool is on the published surface, keyed like every other mutation", () => {
  expect(MCP_TOOL_NAMES).toContain("issue_report");
  expect(MUTATING_MCP_TOOL_NAMES.has("issue_report")).toBe(true);
  const schema = TOOL_INPUT_SCHEMAS.issue_report;
  expect(schema.safeParse({ clientRequestId: "a", action: "preview", title: "t", body: "b" }).success).toBe(true);
  expect(schema.safeParse({ clientRequestId: "a", action: "publish", digest: "f".repeat(64) }).success).toBe(true);
  /* Publication takes no approval from its caller: the field is gone. */
  expect(Object.keys(schema.shape)).not.toContain("approval");
  /* The advertised digest accepts the short value shown by preview. */
  expect(schema.safeParse({ clientRequestId: "a", action: "publish", digest: "f".repeat(8) }).success).toBe(true);
  expect(schema.safeParse({ clientRequestId: "a", action: "file" }).success).toBe(false);
});

test.each([
  "The operator's tool returned E_STREAM.",
  "The operator’s tool returned E_STREAM.",
  "The user's tool returned `connection refused during startup`.",
])("ordinary possessive technical evidence remains publishable: %s", async (body) => {
  const h = harness({ deny: { accounts: [], people: [], local: [], projects: [] } });
  for (const encoded of [body, encodeURIComponent(body), [...body].map((char) => `&#${char.codePointAt(0)};`).join("")]) {
    const report = { title: REPORT.title, body: encoded };
    const digest = await previewed(h, report);
    await h.approves(digest);
    expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: true, published: true });
    expect(h.published.at(-1)).toEqual({ ...report, repository: REPOSITORY });
  }
});

test("technical numeric evidence and source line references remain publishable", async () => {
  const h = harness({ deny: { accounts: [], people: [], local: [], projects: [] } });
  for (const body of [
    "The response carried HTTP status: 503.",
    "The receipt had retryAfterMs: 1000.",
    "Observed attempts: 3; expected attempts: 1.",
    "The settlement path is src/lib/mcp/bindings.ts:1767.",
    "See README.md:12 and ./src/lib/mcp/bindings.ts:1767.",
  ]) {
    const report = { title: REPORT.title, body };
    const digest = await previewed(h, report);
    await h.approves(digest);
    expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: true, published: true });
    expect(h.published.at(-1)).toEqual({ ...report, repository: REPOSITORY });
  }
});

test("the seat asks in a decision form, and the operator's approving choice files exactly that text, once", async () => {
  const h = harness();
  const digest = await previewed(h);

  const answer = await h.call(SEAT_CALLER, { action: "show", digest });
  expect(answer).toMatchObject({ ok: true, title: REPORT.title, body: REPORT.body, digest: shortId(digest) });
  expect(answer.approvalForm).toEqual({ issueReport: shortId(digest) });
  const form = issueReportApprovalForm({ digest, title: REPORT.title }, "en");
  expect(form).toEqual(issueReportApprovalForm({ digest, title: REPORT.title }, "en"));
  /* Its approving option names the whole digest; the others refuse or ask for an edit. */
  expect(form.questions).toHaveLength(1);
  expect(form.questions[0]).toMatchObject({ id: ISSUE_REPORT_QUESTION_ID, other: true });
  expect(form.questions[0]!.options.map((option) => option.label)).toEqual([issueReportApprovalReplies(digest).en, "No, change the text first", "No, do not publish it"]);
  expect(answer).not.toHaveProperty("approvalReplies");
  expect(answer).not.toHaveProperty("approvalReplyDrafts");
  /* A reader who is no seat gets the text and no form to ask. */
  expect((await h.call(REPORTER, { action: "show", digest })).approvalForm).toBeUndefined();

  const reviewId = await h.asks(digest);
  expect(loadSeatRounds(PROJECT)).toEqual([expect.objectContaining({ id: reviewId, taskId: null, title: form.title, questions: form.questions, source: expect.objectContaining({ conversationId: SEAT }) })]);
  /* Asked and not answered yet. */
  expect(await h.call(SEAT_CALLER, { action: "publish", digest }))
    .toMatchObject({ ok: false, code: "issue_report_approval_required", details: { reason: "not_answered", reviewId: shortId(reviewId) } });
  expect(h.published).toEqual([]);

  await h.decides(reviewId);
  const published = await h.call(SEAT_CALLER, { action: "publish", digest });
  expect(published).toMatchObject({ ok: true, published: true, issueUrl: ISSUE_URL, state: "published" });
  expect(h.published).toEqual([{ ...REPORT, repository: REPOSITORY }]);
  const decision = loadSeatRounds(PROJECT)[0]!.decision!;
  expect(decision.decidedBy).toEqual({ kind: "operator" });
  expect(readIssueReportPreview(digest, sandbox)?.publication).toMatchObject({
    by: SEAT, approval: issueReportApprovalReplies(digest).en, reviewId, approvedAt: decision.at, issueUrl: ISSUE_URL,
  });

  /* A second publication of the same preview answers the issue that exists. */
  const again = await h.call(SEAT_CALLER, { action: "publish", digest });
  expect(again).toMatchObject({ ok: true, published: true, replay: true, issueUrl: ISSUE_URL });
  expect(h.published).toHaveLength(1);
});

test("the form is asked in the operator's language, and its English twin approves as well", async () => {
  const h = harness({ locale: "uk" });
  const digest = await previewed(h);
  const shown = await h.call(SEAT_CALLER, { action: "show", digest });
  expect(shown.approvalForm).toEqual({ issueReport: shortId(digest) });
  expect(issueReportApprovalForm({ digest, title: REPORT.title }, "uk").questions[0]!.options[0]!.label).toBe(issueReportApprovalReplies(digest).uk);
  expect(shown.next).toContain("publish_prototype_review");

  await h.decides(await h.asks(digest, SEAT_CALLER, issueReportApprovalForm({ digest, title: REPORT.title }, "en")));
  expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: true, published: true });
  expect(readIssueReportPreview(digest, sandbox)?.publication?.approval).toBe(issueReportApprovalReplies(digest).en);
});

test("a digest that does not match the approved preview is refused and nothing is filed", async () => {
  const h = harness();
  const digest = await previewed(h);
  await h.approves(digest);

  /* The digest of an edited text nobody previewed. */
  const edited = issueReportDigest({ title: REPORT.title, body: `${REPORT.body}\nOne more sentence.` });
  expect(edited).not.toBe(digest);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest: edited }))
    .toMatchObject({ ok: false, code: "issue_report_digest_mismatch" });

  /* A stored preview whose text was changed under its digest. */
  const file = path.join(sandbox, `${digest}.json`);
  const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { body: string };
  fs.writeFileSync(file, JSON.stringify({ ...stored, body: `${stored.body}\nSlipped in after approval.` }));
  expect(await h.call(SEAT_CALLER, { action: "publish", digest }))
    .toMatchObject({ ok: false, code: "issue_report_digest_mismatch" });

  expect(h.published).toEqual([]);
});

test("a form that is not this preview's approval form approves nothing, even answered yes", async () => {
  const h = harness();
  const digest = await previewed(h);
  const exact = issueReportApprovalForm({ digest, title: REPORT.title }, "en");
  const question = exact.questions[0]!;
  const other = issueReportApprovalForm({ digest: "e".repeat(64), title: REPORT.title }, "en");
  for (const form of [
    { ...exact, title: "Publish it?" },
    { ...exact, questions: [{ ...question, text: "Publish?" }] },
    { ...exact, questions: [{ ...question, other: undefined }] },
    { ...exact, questions: [{ ...question, options: [question.options[0]!, { label: "No" }] }] },
    { ...exact, questions: [{ ...question, options: [{ label: question.options[1]!.label, recommended: true }, { label: question.options[0]!.label }, question.options[2]!] }] },
    issueReportApprovalForm({ digest, title: "Another title" }, "en"),
    other,
  ] as ApprovalForm[]) {
    await h.decides(await h.asks(digest, SEAT_CALLER, form));
    expect(await h.call(SEAT_CALLER, { action: "publish", digest }))
      .toMatchObject({ ok: false, code: "issue_report_approval_required", details: { reason: "no_form" } });
  }
  expect(h.published).toEqual([]);
});

test("two previews need two forms: the yes to one never publishes the other", async () => {
  const h = harness();
  const otherReport = { ...REPORT, title: "Delegatus refuses a requested launch" };
  const first = await previewed(h);
  const second = await previewed(h, otherReport);
  await h.approves(first);
  await h.call(SEAT_CALLER, { action: "show", digest: second });
  expect(await h.call(SEAT_CALLER, { action: "publish", digest: second }))
    .toMatchObject({ ok: false, code: "issue_report_approval_required", details: { reason: "no_form" } });
  await h.approves(second);
  for (const digest of [first, second]) expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: true, published: true });
  expect(h.published).toEqual([{ ...REPORT, repository: REPOSITORY }, { ...otherReport, repository: REPOSITORY }]);
});

test("an agent's decision of the form approves nothing, and the operator's later choice does", async () => {
  const h = harness();
  const digest = await previewed(h);
  const reviewId = await h.asks(digest);
  const world: PrototypeWorld = { ...prototypeWorld, orchestrator: () => null };
  expect(decidePrototype({ kind: "autonomous-seat", project: PROJECT, conversationId: SEAT, authorize: () => {} }, null, { reviewId, chosen: [], comment: "", ...YES }, world)).toBe(true);
  await settlePrototypeDeliveriesForTests();
  expect(loadSeatRounds(PROJECT)[0]!.decision?.decidedBy).toEqual({ kind: "agent", conversationId: SEAT });
  expect(await h.call(SEAT_CALLER, { action: "publish", digest }))
    .toMatchObject({ ok: false, code: "issue_report_approval_required", details: { reason: "not_an_approval", reviewId: shortId(reviewId) } });
  expect(h.published).toEqual([]);

  /* The operator confirms the agent's choice with the same answer: a person decided it now. */
  await h.decides(reviewId);
  expect(loadSeatRounds(PROJECT)[0]!.decision).toMatchObject({ decidedBy: { kind: "operator" }, revision: 2 });
  expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: true, published: true });
});

test.each([
  ["the edit option", EDIT_FIRST],
  ["the refusing option", NO],
  ["«Other» with a note", { comment: "Publish it after the title changes", answers: [{ questionId: ISSUE_REPORT_QUESTION_ID, options: [], other: true }] }],
  ["the form taken on its recommendations", { skip: true }],
  ["the question set aside", { answers: [{ questionId: ISSUE_REPORT_QUESTION_ID, options: [], skipped: true }] }],
] as const)("%s approves nothing", async (_name, answer) => {
  const h = harness();
  const digest = await previewed(h);
  const reviewId = await h.asks(digest);
  await h.decides(reviewId, answer as Partial<DecidePrototypeInput>);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest }))
    .toMatchObject({ ok: false, code: "issue_report_approval_required", details: { reason: "not_an_approval", reviewId: shortId(reviewId) } });
  expect(h.published).toEqual([]);
});

test("an amended answer counts as it now stands", async () => {
  const h = harness();
  const digest = await previewed(h);
  const reviewId = await h.asks(digest);
  await h.decides(reviewId);
  await h.decides(reviewId, NO);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest }))
    .toMatchObject({ ok: false, code: "issue_report_approval_required", details: { reason: "not_an_approval" } });
  expect(h.published).toEqual([]);
  await h.decides(reviewId);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: true, published: true });
  expect(h.published).toHaveLength(1);
});

test.each(["en", "uk"] as const)("a refusal explains in %s how to ask and which option approves", async (locale) => {
  const h = harness({ locale });
  const digest = await previewed(h);
  await h.call(SEAT_CALLER, { action: "show", digest });
  const unasked = await h.call(SEAT_CALLER, { action: "publish", digest });
  expect(unasked).toMatchObject({ ok: false, code: "issue_report_approval_required", details: { reason: "no_form" } });
  expect(unasked.error).toContain("publish_prototype_review");
  expect(unasked.error).toContain("issueReport");

  const reviewId = await h.asks(digest);
  const waiting = await h.call(SEAT_CALLER, { action: "publish", digest });
  expect(waiting.error).toContain(shortId(reviewId));
  expect(waiting.error).toContain(locale === "uk" ? "ще не відповів" : "has not answered");

  await h.decides(reviewId, EDIT_FIRST);
  const refused = await h.call(SEAT_CALLER, { action: "publish", digest });
  expect(refused.error).toContain(issueReportApprovalReplies(shortId(digest))[locale]);
  expect(h.published).toEqual([]);
});

test("show guidance and the published tool description send the approval through a decision form", async () => {
  const h = harness();
  const digest = await previewed(h);
  const answer = await h.call(SEAT_CALLER, { action: "show", digest });
  expect(answer.next).toContain("publish_prototype_review");
  expect(answer.next).toContain("approvalForm");
  expect(answer.next).not.toContain("suggest_replies");
  const bindings = viewerMcpBindings(undefined, undefined, {} as never);
  const server = createViewerMcpServer(createMcpToolService(bindings, new MemoryMcpReceiptStore()));
  const client = new Client({ name: "approval-guidance-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const description = (await client.listTools()).tools.find((tool) => tool.name === "issue_report")!.description;
    expect(description).toContain("approvalForm");
    expect(description).toContain("publish_prototype_review");
    expect(description).not.toContain("suggest_replies");
  } finally {
    await client.close();
    await server.close();
  }
});

/* Review finding 1: an approval was whatever string the seat passed. Each of
   the following reached the forge; none does now. */
test("no form, an unanswered one, and the seat's own account of an approval file nothing", async () => {
  const h = harness();
  const digest = await previewed(h);

  /* Not read back yet. */
  expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: false, code: "issue_report_not_shown" });
  await h.call(SEAT_CALLER, { action: "show", digest });

  /* Nothing asked since. */
  expect(await h.call(SEAT_CALLER, { action: "publish", digest }))
    .toMatchObject({ ok: false, code: "issue_report_approval_required", details: { reason: "no_form" } });

  /* What the seat passes is no evidence, whatever it says. */
  const reviewId = await h.asks(digest);
  for (const approval of ["yes", issueReportApprovalReplies(digest).en, reviewId]) {
    expect(await h.call(SEAT_CALLER, { action: "publish", digest, approval }))
      .toMatchObject({ ok: false, code: "issue_report_approval_required", details: { reason: "not_answered" } });
  }
  expect(h.published).toEqual([]);
});

test("the yes for one preview never publishes another whose digest begins the same way", async () => {
  const h = harness();
  const title = "Delegatus refuses a requested launch";
  const approved = { title, body: "The launch was refused during check 4388." };
  const sibling = { title, body: "The launch was refused during check 181675." };
  const approvedDigest = await previewed(h, approved);
  const siblingDigest = await previewed(h, sibling);
  /* The pair is real: their digests differ and share their first eight characters. */
  expect(approvedDigest).not.toBe(siblingDigest);
  expect(siblingDigest.slice(0, 8)).toBe(approvedDigest.slice(0, 8));
  await h.call(SEAT_CALLER, { action: "show", digest: siblingDigest });
  await h.approves(approvedDigest);

  expect(await h.call(SEAT_CALLER, { action: "publish", digest: siblingDigest }))
    .toMatchObject({ ok: false, code: "issue_report_approval_required", details: { reason: "no_form" } });
  expect(h.published).toEqual([]);

  expect(await h.call(SEAT_CALLER, { action: "publish", digest: approvedDigest })).toMatchObject({ ok: true, published: true });
  expect(h.published).toEqual([{ ...approved, repository: REPOSITORY }]);
});

test("a form counts only when asked after the preview was read back, and only the newest one", async () => {
  const h = harness();
  const digest = await previewed(h);
  /* Asked before the seat could have shown the text. */
  const early = await h.as(SEAT_CALLER).callTool("publish_prototype_review", { clientRequestId: "early-form", ...issueReportApprovalForm({ digest, title: REPORT.title }, "en") }) as McpToolResult & Record<string, unknown>;
  expect(early.ok).toBe(true);
  await h.decides(early.reviewId as string);
  tick();
  await h.call(SEAT_CALLER, { action: "show", digest });
  expect(await h.call(SEAT_CALLER, { action: "publish", digest }))
    .toMatchObject({ ok: false, code: "issue_report_approval_required", details: { reason: "no_form" } });

  /* Approved, then asked again: the newer, unanswered form is the one that counts. */
  await h.approves(digest);
  const newer = await h.asks(digest);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest }))
    .toMatchObject({ ok: false, code: "issue_report_approval_required", details: { reason: "not_answered", reviewId: shortId(newer) } });
  expect(h.published).toEqual([]);

  await h.decides(newer);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: true, published: true });
  expect(h.published).toHaveLength(1);
});

test("an approval of one preview does not move to another text or another conversation", async () => {
  const h = harness();
  const first = await previewed(h);
  await h.approves(first);
  const secondReport = { title: REPORT.title, body: `${REPORT.body}\nIt happened twice in one hour.` };
  const second = await previewed(h, secondReport);
  expect(second).not.toBe(first);

  /* The seat has not read the edited text back, so it cannot have shown it. */
  expect(await h.call(SEAT_CALLER, { action: "publish", digest: second })).toMatchObject({ ok: false, code: "issue_report_not_shown" });

  /* Read back after the yes to the first text: that yes names another preview. */
  await h.call(SEAT_CALLER, { action: "show", digest: second });
  expect(await h.call(SEAT_CALLER, { action: "publish", digest: second }))
    .toMatchObject({ ok: false, code: "issue_report_approval_required", details: { reason: "no_form" } });

  /* The second text approved in another seat's conversation. */
  await h.approves(second, OTHER_SEAT_CALLER);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest: second }))
    .toMatchObject({ ok: false, code: "issue_report_approval_required", details: { reason: "no_form" } });
  expect(h.published).toEqual([]);

  await h.approves(second);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest: second })).toMatchObject({ ok: true, published: true });
  expect(h.published).toEqual([{ ...secondReport, repository: REPOSITORY }]);
});

test("only the seat itself publishes", async () => {
  const h = harness();
  const digest = await previewed(h);
  await h.approves(digest);

  for (const caller of [REPORTER, DEPUTY]) {
    expect(await h.call(caller, { action: "publish", digest }))
      .toMatchObject({ ok: false, code: caller === REPORTER ? "issue_reporter_write_refused" : "issue_report_publish_refused" });
  }
  expect(h.published).toEqual([]);
});

/* Review findings 2 to 5, at the tool boundary: each body below was stored. */
test("concurrent publications of one digest reach the forge once, whoever calls and under whatever request id", async () => {
  let release = () => {};
  const held = new Promise<void>((resolve) => { release = resolve; });
  const h = harness({ publisher: async () => { await held; return ISSUE_URL; } });
  const digest = await previewed(h);
  for (const seat of [SEAT_CALLER, OTHER_SEAT_CALLER]) await h.approves(digest, seat);
  const racing = [SEAT_CALLER, OTHER_SEAT_CALLER, SEAT_CALLER, OTHER_SEAT_CALLER].map((seat) => h.call(seat, { action: "publish", digest }));
  await new Promise((resolve) => setTimeout(resolve, 50));
  /* A reading that arrives while the claim is held changes nothing about it. */
  await h.call(SEAT_CALLER, { action: "show", digest });
  expect(readIssueReportPreview(digest, sandbox)?.state).toBe("publishing");
  release();
  const answers = await Promise.all(racing);
  expect(h.published).toHaveLength(1);
  expect(answers.filter((answer) => answer.ok && answer.published === true && answer.replay !== true)).toHaveLength(1);
  for (const answer of answers.filter((row) => !(row.ok && row.published === true))) {
    expect(answer).toMatchObject({ ok: false, code: "issue_report_outcome_unknown" });
  }
  expect(await h.call(OTHER_SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: true, replay: true, issueUrl: ISSUE_URL });
  expect(h.published).toHaveLength(1);
});

/* Review finding 8: any failure put the preview back and said "retry". */
test("a publication whose outcome is unknown is never repeated, and is settled by finding the issue", async () => {
  let existing: string | null = null;
  const h = harness({
    publisher: async () => { throw new Error("the forge accepted the command and answered no issue URL"); },
    finder: async () => existing,
  });
  const digest = await previewed(h);
  await h.approves(digest);

  const first = await h.call(SEAT_CALLER, { action: "publish", digest });
  expect(first.ok).toBe(false);
  expect(first.code).not.toBe("issue_report_publish_failed");
  expect(readIssueReportPreview(digest, sandbox)?.state).toBe("publishing");

  /* A new request id, a new approval, another seat: none files it again. */
  await h.approves(digest);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: false, code: "issue_report_outcome_unknown", retryable: false });
  await h.approves(digest, OTHER_SEAT_CALLER);
  expect(await h.call(OTHER_SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: false, code: "issue_report_outcome_unknown" });
  expect(h.published).toHaveLength(1);

  /* The issue turns up in the repository: the publication is settled on it. */
  existing = ISSUE_URL;
  expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: true, published: true, reconciled: true, issueUrl: ISSUE_URL });
  expect(readIssueReportPreview(digest, sandbox)).toMatchObject({ state: "published", publication: { issueUrl: ISSUE_URL } });
  expect(h.published).toHaveLength(1);
});

test("a lost answer is settled at once when the issue is already there", async () => {
  const h = harness({ publisher: async () => { throw Object.assign(new Error("socket hang up"), { stderr: "error connecting" }); }, finder: async () => ISSUE_URL });
  const digest = await previewed(h);
  await h.approves(digest);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: true, published: true, reconciled: true, issueUrl: ISSUE_URL });
  expect(h.published).toHaveLength(1);
});

test("a refusal that provably came before the write frees the preview for another try", async () => {
  let refuse = true;
  const h = harness({
    publisher: async () => {
      if (refuse) throw new ForgeAppWriteRefused("Delegatus refused this GitHub write: the App is not installed");
      return ISSUE_URL;
    },
  });
  const digest = await previewed(h);
  await h.approves(digest);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: false, code: "issue_report_publish_failed", retryable: true });
  expect(readIssueReportPreview(digest, sandbox)?.state).toBe("preview");

  refuse = false;
  expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: true, published: true, issueUrl: ISSUE_URL });
  expect(h.published).toHaveLength(2);
});

test("a preview needs an identified session and a one-line title", async () => {
  const h = harness();
  expect(await h.call({ kind: "unidentified", conversationId: null, role: null }, { action: "preview", ...REPORT }))
    .toMatchObject({ ok: false, code: "issue_report_caller_unidentified" });
  expect(await h.call(REPORTER, { action: "preview", title: "two\nlines", body: REPORT.body }))
    .toMatchObject({ ok: false, code: "issue_report_invalid", details: { field: "title" } });
  expect(fs.readdirSync(sandbox)).toEqual([]);
});


test("the reporter's hint tool returns class and matched span without storage", async () => {
  const h = harness();
  const body = `The log is under ${["", "home", "someone", "work"].join("/")}.`;
  const answer = await h.call(REPORTER, { action: "hints", title: REPORT.title, body });
  expect(answer.ok).toBe(true);
  const hints = answer.hints as { class: string; where: string; span: { start: number; end: number; text: string } }[];
  const hint = hints.find((hint) => hint.class === "path")!;
  expect(hint.where).toBe("body");
  expect(body.slice(hint.span.start, hint.span.end)).toBe(hint.span.text);
  expect(hint.span.text).toContain("someone");
  expect(fs.readdirSync(sandbox)).toEqual([]);
  expect(answer.next).toContain("clean result proves nothing");
});

test.each([
  ["host", "It could not reach local" + "host."],
  ["path", `The log is under ${["", "home", "someone", "work"].join("/")}.`],
  ["email", `The contact is ${["mailbox", ["example", "org"].join(".")].join("@")} .`],
  ["id", `The lane ${"3f2b" + "8c1e"} stopped.`],
  ["quote", 'The tool answered "connection refused during startup".'],
  ["person", "Person Bee observed the failure."],
])("a %s hint never blocks preview, storage or approved publication", async (kind, body) => {
  const h = harness({ deny: { ...DENY, people: ["Person Bee"] } });
  for (const where of ["title", "body"] as const) {
    const report = { ...REPORT, [where]: body };
    const answer = await h.call(REPORTER, { action: "preview", ...report });
    expect(answer).toMatchObject({ ok: true, privacyJudgment: JUDGMENT });
    expect(answer.hints).toEqual(expect.arrayContaining([expect.objectContaining({ class: kind, where, span: expect.objectContaining({ text: expect.any(String) }) })]));
    const digest = issueReportDigest(report);
    expect(readIssueReportPreview(digest, sandbox)).toMatchObject({ ...report, privacyJudgment: JUDGMENT, hints: answer.hints });
    const shown = await h.call(SEAT_CALLER, { action: "show", digest });
    expect(shown).toMatchObject({ ...report, privacyJudgment: JUDGMENT, hints: answer.hints });
    expect(shown.next).toContain("operator may approve text with hints");
    expect(shown.previewText).toContain(report.title);
    expect(shown.previewText).toContain(report.body);
    expect(shown.previewText).toContain(JUDGMENT.assessment);
    expect(shown.previewText).toContain("Detector hints");
    expect(shown.previewLanguage).toBe("en");
    expect(shown.approvalForm).toEqual({ issueReport: shortId(digest) });
    expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: false, code: "issue_report_approval_required" });
    await h.approves(digest);
    expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: true, published: true });
    expect(h.published.at(-1)).toEqual({ ...report, repository: REPOSITORY });
  }
});

test("an approved legacy preview with hints reaches the publisher", async () => {
  const h = harness();
  const report = { title: REPORT.title, body: "It could not reach local" + "host." };
  const legacy = recordIssueReportPreview(report, null, { directory: sandbox });
  const shown = await h.call(SEAT_CALLER, { action: "show", digest: legacy.digest });
  expect(shown.hints).toEqual(expect.arrayContaining([expect.objectContaining({ class: "host" })]));
  expect(shown.privacyJudgment).toMatchObject({ assessment: expect.stringContaining("legacy preview") });
  await h.approves(legacy.digest);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest: legacy.digest })).toMatchObject({ ok: true, published: true });
  expect(h.published).toEqual([{ ...report, repository: REPOSITORY }]);
});

test("missing hint sources are advisory and cannot block storage or publication", async () => {
  const h = harness({ privacyRead: async () => { throw new Error("private source failure"); } });
  const report = { ...REPORT, body: "It could not reach local" + "host." };
  const answer = await h.call(REPORTER, { action: "preview", ...report });
  expect(answer).toMatchObject({ ok: true, hintWarnings: [expect.stringContaining("unavailable")] });
  expect(answer.hints).toEqual(expect.arrayContaining([expect.objectContaining({ class: "host" })]));
  const digest = issueReportDigest(report);
  const shown = await h.call(SEAT_CALLER, { action: "show", digest });
  expect(shown.hintWarnings).toEqual(answer.hintWarnings);
  await h.approves(digest);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: true, published: true });
  expect(JSON.stringify(answer)).not.toContain("private source failure");
});

test("preview carries the agent's judgment even with no detector hints", async () => {
  const h = harness();
  const answer = await h.call(REPORTER, { action: "preview", ...REPORT });
  expect(answer).toMatchObject({ ok: true, privacyJudgment: JUDGMENT, hints: [] });
  expect(await h.call(SEAT_CALLER, { action: "show", digest: answer.digest })).toMatchObject({ privacyJudgment: JUDGMENT });
  expect(await h.call(REPORTER, { action: "preview", ...REPORT, privacyJudgment: undefined })).toMatchObject({ ok: false, code: "issue_report_invalid", details: { field: "privacyJudgment" } });
});
