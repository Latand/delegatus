import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PublicDenyList } from "@/lib/bridge/publicSafe";
import { ForgeAppWriteRefused } from "@/lib/forge/appWrite";
import { issueReportApprovalReplies } from "@/lib/issueReports/approval";
import { issueReportDigest, readIssueReportPreview, recordIssueReportPreview } from "@/lib/issueReports/store";

import { viewerMcpBindings, viewerMcpToolPolicy, type CallerAttribution } from "./bindings";
import { createMcpToolService, MemoryMcpReceiptStore, MCP_TOOL_NAMES, MUTATING_MCP_TOOL_NAMES, TOOL_INPUT_SCHEMAS, type McpToolResult } from "./server";

/*
 * #2518 at the tool boundary: detector hints accompany the agent judgment.
 * What is filed is the stored preview the operator approved,
 * named by its digest. Nothing here files an issue: the publisher is a fake
 * that records what it was handed.
 */

let sandbox = "";
let privacyState = "";
let previousState: string | undefined;

beforeEach(() => {
  sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-issue-report-"));
  privacyState = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-privacy-sources-"));
  previousState = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = privacyState;
});
afterEach(() => {
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(sandbox, { recursive: true, force: true });
  fs.rmSync(privacyState, { recursive: true, force: true });
});

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

function harness(options: { publisher?: Publisher; finder?: (report: { title: string; body: string }) => Promise<string | null>; deny?: PublicDenyList; privacyRead?: () => Promise<void>; controlRead?: (url: string) => Promise<Record<string, unknown>> } = {}) {
  const published: { title: string; body: string; repository: string }[] = [];
  /* What the operator wrote, per conversation: the fake of the transcript read. */
  const said = new Map<string, { at: number; text: string }[]>();
  const operatorSays = (words: string, conversationId = SEAT) => {
    /* The next millisecond: a message is after a reading only by the clock. */
    const from = Date.now();
    while (Date.now() === from) { /* wait */ }
    said.set(conversationId, [...(said.get(conversationId) ?? []), { at: Date.now(), text: words }]);
  };
  /* Every caller gets its own service and receipt store, as every agent has
     its own MCP server process over the one state directory. */
  const as = (caller: CallerAttribution) => {
    const domain = {
      attentionAuthority: () => (caller.conversationId
        ? { kind: "worker", conversationId: caller.conversationId, role: caller.role }
        : { kind: "unidentified" }),
      callerAttribution: () => caller,
      publicDenyList: options.privacyRead || options.controlRead ? undefined : () => options.deny ?? DENY,
      viewerProjects: () => ["repo-report"],
      issueReportsDir: () => sandbox,
      issueReportRepository: () => REPOSITORY,
      operatorMessages: async (conversationId: string) => said.get(conversationId) ?? [],
      issueReportFinder: async (report: { title: string; body: string }) => (options.finder ? options.finder(report) : null),
      issueReportPublisher: async (report: { title: string; body: string }, repository: string) => {
        published.push({ ...report, repository });
        return options.publisher ? options.publisher(report, repository) : ISSUE_URL;
      },
    };
    const control = options.privacyRead || options.controlRead ? {
      post: async () => { throw new Error("unexpected control mutation"); },
      get: async (url: string) => {
        if (options.controlRead) return options.controlRead(url);
        expect(url).toBe("/api/telegram/bot/agent?op=chats&includeInactive=1");
        await options.privacyRead!();
        return { chats: [] };
      },
    } : undefined;
    return createMcpToolService(viewerMcpBindings(undefined, control, domain as never), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(domain as never));
  };
  let next = 0;
  const call = (caller: CallerAttribution, args: Record<string, unknown>) =>
    as(caller).callTool("issue_report", { clientRequestId: `issue-report-${next += 1}`, ...(args.action === "preview" ? { privacyJudgment: JUDGMENT } : {}), ...args }) as Promise<McpToolResult & Record<string, unknown>>;
  return { call, published, operatorSays };
}

async function previewed(h: ReturnType<typeof harness>, report = REPORT): Promise<string> {
  const preview = await h.call(REPORTER, { action: "preview", ...report });
  expect(preview.ok).toBe(true);
  return preview.digest as string;
}

/** The seat reads the preview back; the answer names the reply that approves it. */
async function shown(h: ReturnType<typeof harness>, digest: string, seat = SEAT_CALLER): Promise<{ en: string; uk: string }> {
  const answer = await h.call(seat, { action: "show", digest });
  expect(answer.ok).toBe(true);
  return answer.approvalReplies as { en: string; uk: string };
}

test("the tool is on the published surface, keyed like every other mutation", () => {
  expect(MCP_TOOL_NAMES).toContain("issue_report");
  expect(MUTATING_MCP_TOOL_NAMES.has("issue_report")).toBe(true);
  const schema = TOOL_INPUT_SCHEMAS.issue_report;
  expect(schema.safeParse({ clientRequestId: "a", action: "preview", title: "t", body: "b" }).success).toBe(true);
  expect(schema.safeParse({ clientRequestId: "a", action: "publish", digest: "f".repeat(64) }).success).toBe(true);
  /* Publication takes no approval from its caller: the field is gone. */
  expect(Object.keys(schema.shape)).not.toContain("approval");
  /* A digest is the whole 64 characters; a shortened one names nothing. */
  expect(schema.safeParse({ clientRequestId: "a", action: "publish", digest: "f".repeat(8) }).success).toBe(false);
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
    h.operatorSays((await shown(h, digest)).en);
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
    h.operatorSays((await shown(h, digest)).en);
    expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: true, published: true });
    expect(h.published.at(-1)).toEqual({ ...report, repository: REPOSITORY });
  }
});

test("the seat reads the preview back, and the operator's approving reply files exactly that text, once", async () => {
  const h = harness();
  const digest = await previewed(h);

  const answer = await h.call(SEAT_CALLER, { action: "show", digest });
  expect(answer).toMatchObject({ ok: true, title: REPORT.title, body: REPORT.body, digest });
  const replies = answer.approvalReplies as { en: string; uk: string };
  expect(replies).toEqual(issueReportApprovalReplies(digest));
  /* A reader who is no seat gets the text and no reply to offer. */
  expect((await h.call(REPORTER, { action: "show", digest })).approvalReplies).toBeUndefined();

  h.operatorSays(replies.uk);
  const published = await h.call(SEAT_CALLER, { action: "publish", digest });
  expect(published).toMatchObject({ ok: true, published: true, issueUrl: ISSUE_URL, state: "published" });
  expect(h.published).toEqual([{ ...REPORT, repository: REPOSITORY }]);
  expect(readIssueReportPreview(digest, sandbox)?.publication).toMatchObject({ by: SEAT, approval: replies.uk, issueUrl: ISSUE_URL });

  /* A second publication of the same preview answers the issue that exists. */
  const again = await h.call(SEAT_CALLER, { action: "publish", digest });
  expect(again).toMatchObject({ ok: true, published: true, replay: true, issueUrl: ISSUE_URL });
  expect(h.published).toHaveLength(1);
});

test("the approving reply is read loosely in its punctuation and case, and in either language", async () => {
  for (const reword of [(reply: string) => reply.toUpperCase(), (reply: string) => `  ${reply.replace(",", "")}.  `, (reply: string) => `${reply}!`]) {
    for (const language of ["en", "uk"] as const) {
      const h = harness();
      const digest = await previewed(h);
      const replies = await shown(h, digest);
      h.operatorSays(reword(replies[language]));
      expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: true, published: true });
    }
  }
});

test("a digest that does not match the approved preview is refused and nothing is filed", async () => {
  const h = harness();
  const digest = await previewed(h);
  const replies = await shown(h, digest);
  h.operatorSays(replies.en);

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

/* Review finding 1: an approval was whatever string the seat passed. Each of
   the following reached the forge; none does now. */
test("no approval, a refusal, and the seat's own account of an approval file nothing", async () => {
  const h = harness();
  const digest = await previewed(h);

  /* Not read back yet. */
  expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: false, code: "issue_report_not_shown" });
  const replies = await shown(h, digest);

  /* The operator has said nothing since. */
  const silent = await h.call(SEAT_CALLER, { action: "publish", digest });
  expect(silent).toMatchObject({ ok: false, code: "issue_report_approval_required", details: { reason: "no_operator_message" } });

  /* What the seat passes is no evidence, whatever it says. */
  for (const approval of ["yes", replies.en, replies.uk]) {
    expect(await h.call(SEAT_CALLER, { action: "publish", digest, approval }))
      .toMatchObject({ ok: false, code: "issue_report_approval_required" });
  }

  /* A refusal, an edit, a bare yes, and a refusal that names the digest. */
  for (const words of ["Ні, не публікуй", "Change the title first", "yes", "так", `Ні, не публікуй звіт ${digest}`, `${replies.en} but change the title`]) {
    h.operatorSays(words);
    expect(await h.call(SEAT_CALLER, { action: "publish", digest }))
      .toMatchObject({ ok: false, code: "issue_report_approval_required", details: { reason: "not_an_approval" } });
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
  const replies = await shown(h, approvedDigest);
  await shown(h, siblingDigest);

  h.operatorSays(replies.en);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest: siblingDigest }))
    .toMatchObject({ ok: false, code: "issue_report_approval_required", details: { reason: "not_an_approval" } });
  expect(h.published).toEqual([]);

  expect(await h.call(SEAT_CALLER, { action: "publish", digest: approvedDigest })).toMatchObject({ ok: true, published: true });
  expect(h.published).toEqual([{ ...approved, repository: REPOSITORY }]);
});

test("an approval counts only after the preview was read back, and only while it is the operator's last word", async () => {
  const h = harness();
  const digest = await previewed(h);
  /* Sent before the seat could have shown the text. */
  h.operatorSays(issueReportApprovalReplies(digest).en);
  const replies = await shown(h, digest);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest }))
    .toMatchObject({ ok: false, code: "issue_report_approval_required", details: { reason: "no_operator_message" } });

  /* Approved, then withdrawn. */
  h.operatorSays(replies.en);
  h.operatorSays("Wait, do not send it yet");
  expect(await h.call(SEAT_CALLER, { action: "publish", digest }))
    .toMatchObject({ ok: false, code: "issue_report_approval_required", details: { reason: "not_an_approval" } });
  expect(h.published).toEqual([]);

  h.operatorSays(replies.en);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: true, published: true });
  expect(h.published).toHaveLength(1);
});

test("an approval of one preview does not move to another text or another conversation", async () => {
  const h = harness();
  const first = await previewed(h);
  const firstReplies = await shown(h, first);
  const second = await previewed(h, { title: REPORT.title, body: `${REPORT.body}\nIt happened twice in one hour.` });
  expect(second).not.toBe(first);

  /* The seat has not read the edited text back, so it cannot have shown it. */
  h.operatorSays(firstReplies.en);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest: second })).toMatchObject({ ok: false, code: "issue_report_not_shown" });

  /* Read back after the yes to the first text: that yes names another preview. */
  const secondReplies = await shown(h, second);
  expect(secondReplies).not.toEqual(firstReplies);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest: second }))
    .toMatchObject({ ok: false, code: "issue_report_approval_required" });
  h.operatorSays(firstReplies.en);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest: second }))
    .toMatchObject({ ok: false, code: "issue_report_approval_required", details: { reason: "not_an_approval" } });

  /* The approving reply of the second text, sent in another seat's conversation. */
  h.operatorSays(secondReplies.en, OTHER_SEAT);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest: second }))
    .toMatchObject({ ok: false, code: "issue_report_approval_required" });
  /* And that other seat never read it back. */
  expect(await h.call(OTHER_SEAT_CALLER, { action: "publish", digest: second })).toMatchObject({ ok: false, code: "issue_report_not_shown" });
  expect(h.published).toEqual([]);

  h.operatorSays(secondReplies.en);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest: second })).toMatchObject({ ok: true, published: true });
  expect(h.published).toEqual([{ title: REPORT.title, body: `${REPORT.body}\nIt happened twice in one hour.`, repository: REPOSITORY }]);
});

test("only the seat itself publishes", async () => {
  const h = harness();
  const digest = await previewed(h);
  const replies = await shown(h, digest);
  h.operatorSays(replies.en);
  h.operatorSays(replies.en, REPORTER.conversationId!);

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
  for (const seat of [SEAT_CALLER, OTHER_SEAT_CALLER]) {
    const replies = await shown(h, digest, seat);
    h.operatorSays(replies.en, seat.conversationId!);
  }
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
  const replies = await shown(h, digest);
  h.operatorSays(replies.en);

  const first = await h.call(SEAT_CALLER, { action: "publish", digest });
  expect(first.ok).toBe(false);
  expect(first.code).not.toBe("issue_report_publish_failed");
  expect(readIssueReportPreview(digest, sandbox)?.state).toBe("publishing");

  /* A new request id, a new approval, another seat: none files it again. */
  h.operatorSays(replies.en);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: false, code: "issue_report_outcome_unknown", retryable: false });
  const otherReplies = await shown(h, digest, OTHER_SEAT_CALLER);
  h.operatorSays(otherReplies.en, OTHER_SEAT);
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
  h.operatorSays((await shown(h, digest)).en);
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
  h.operatorSays((await shown(h, digest)).en);
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
    const digest = answer.digest as string;
    expect(readIssueReportPreview(digest, sandbox)).toMatchObject({ ...report, privacyJudgment: JUDGMENT, hints: answer.hints });
    const shown = await h.call(SEAT_CALLER, { action: "show", digest });
    expect(shown).toMatchObject({ ...report, privacyJudgment: JUDGMENT, hints: answer.hints });
    expect(shown.next).toContain("operator may approve text with hints");
    expect(shown.previewText).toContain(report.title);
    expect(shown.previewText).toContain(report.body);
    expect(shown.previewText).toContain(JUDGMENT.assessment);
    expect(shown.previewText).toContain("Detector hints");
    expect(shown.previewLanguage).toBe("en");
    const drafts = shown.approvalReplyDrafts as Record<"en" | "uk", { label: string; text: string }>;
    expect(drafts.en.text).toBe((shown.approvalReplies as { en: string }).en);
    expect(drafts.uk.text).toBe((shown.approvalReplies as { uk: string }).uk);
    expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: false, code: "issue_report_approval_required" });
    h.operatorSays((shown.approvalReplies as { en: string }).en);
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
  h.operatorSays((shown.approvalReplies as { en: string }).en);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest: legacy.digest })).toMatchObject({ ok: true, published: true });
  expect(h.published).toEqual([{ ...report, repository: REPOSITORY }]);
});

test("missing hint sources are advisory and cannot block storage or publication", async () => {
  const h = harness({ privacyRead: async () => { throw new Error("private source failure"); } });
  const report = { ...REPORT, body: "It could not reach local" + "host." };
  const answer = await h.call(REPORTER, { action: "preview", ...report });
  expect(answer).toMatchObject({ ok: true, hintWarnings: [expect.stringContaining("unavailable")] });
  expect(answer.hints).toEqual(expect.arrayContaining([expect.objectContaining({ class: "host" })]));
  const digest = answer.digest as string;
  const shown = await h.call(SEAT_CALLER, { action: "show", digest });
  expect(shown.hintWarnings).toEqual(answer.hintWarnings);
  h.operatorSays((shown.approvalReplies as { en: string }).en);
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
