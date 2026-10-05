import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { PublicDenyList } from "@/lib/bridge/publicSafe";
import { issueReportDigest, readIssueReportPreview } from "@/lib/issueReports/store";

import { viewerMcpBindings, type CallerAttribution } from "./bindings";
import { createMcpToolService, MemoryMcpReceiptStore, MCP_TOOL_NAMES, MUTATING_MCP_TOOL_NAMES, TOOL_INPUT_SCHEMAS, type McpToolResult } from "./server";

/*
 * #2518 at the tool boundary: a Delegatus bug report is checked before it can
 * be previewed, and what is filed is the stored preview the operator approved,
 * named by its digest. Nothing here files an issue: the publisher is a fake
 * that records what it was handed.
 */

let sandbox = "";

beforeEach(() => { sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-mcp-issue-report-")); });
afterEach(() => { fs.rmSync(sandbox, { recursive: true, force: true }); });

const SEAT = "conversation_seat";
const SEAT_CALLER: CallerAttribution = { kind: "manager", conversationId: SEAT, role: "orchestrator" };
const REPORTER: CallerAttribution = { kind: "agent", conversationId: "conversation_reporter", role: "issue-reporter" };
const DEPUTY: CallerAttribution = { kind: "manager", conversationId: SEAT, role: "orchestrator", via: { deputy: "conversation_deputy" } };
const DENY: PublicDenyList = { accounts: ["claude-main-b"], people: [], local: [], projects: [] };
const REPOSITORY = "example/delegatus";
const ISSUE_URL = `https://${["github", "com"].join(".")}/${REPOSITORY}/issues/4242`;

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

function harness() {
  const published: { title: string; body: string; repository: string }[] = [];
  const receipts = new MemoryMcpReceiptStore();
  const as = (caller: CallerAttribution) => createMcpToolService(
    viewerMcpBindings(undefined, undefined, {
      attentionAuthority: () => (caller.conversationId
        ? { kind: "worker", conversationId: caller.conversationId, role: caller.role }
        : { kind: "unidentified" }),
      callerAttribution: () => caller,
      publicDenyList: () => DENY,
      issueReportsDir: () => sandbox,
      issueReportRepository: () => REPOSITORY,
      issueReportPublisher: async (report: { title: string; body: string }, repository: string) => {
        published.push({ ...report, repository });
        return ISSUE_URL;
      },
    } as never),
    receipts,
  );
  let next = 0;
  const call = (caller: CallerAttribution, args: Record<string, unknown>) =>
    as(caller).callTool("issue_report", { clientRequestId: `issue-report-${next += 1}`, ...args }) as Promise<McpToolResult & Record<string, unknown>>;
  return { call, published };
}

async function previewed(h: ReturnType<typeof harness>, report = REPORT): Promise<string> {
  const preview = await h.call(REPORTER, { action: "preview", ...report });
  expect(preview.ok).toBe(true);
  return preview.digest as string;
}

test("the tool is on the published surface, keyed like every other mutation", () => {
  expect(MCP_TOOL_NAMES).toContain("issue_report");
  expect(MUTATING_MCP_TOOL_NAMES.has("issue_report")).toBe(true);
  const schema = TOOL_INPUT_SCHEMAS.issue_report;
  expect(schema.safeParse({ clientRequestId: "a", action: "preview", title: "t", body: "b" }).success).toBe(true);
  expect(schema.safeParse({ clientRequestId: "a", action: "publish", digest: "f".repeat(64), approval: "yes" }).success).toBe(true);
  /* A digest is the whole 64 characters; a shortened one names nothing. */
  expect(schema.safeParse({ clientRequestId: "a", action: "publish", digest: "f".repeat(8), approval: "yes" }).success).toBe(false);
  expect(schema.safeParse({ clientRequestId: "a", action: "file" }).success).toBe(false);
});

test("a body with a host, a path, an email or an id is refused before any preview exists", async () => {
  const h = harness();
  const cases: [string, string][] = [
    ["domain", `It failed on ${["build", "box"].join("-")}.${"lan"} only.`],
    ["path", `The file is ${["", "home", "someone", "state", "tasks.json"].join("/")}.`],
    ["email", `The account belongs to ${["someone", ["mail", "example", "org"].join(".")].join("@")}.`],
    ["id", `The lane ${"0f01" + "39a6"} parked.`],
    ["account", "The launch picked claude-main-b."],
  ];
  for (const [kind, line] of cases) {
    const refused = await h.call(REPORTER, { action: "preview", title: REPORT.title, body: `${REPORT.body}\n${line}` });
    expect(refused).toMatchObject({ ok: false, code: "issue_report_private_data" });
    const findings = (refused.details as { findings: { class: string; where: string; lines: number[] }[] }).findings;
    expect(findings.map((finding) => finding.class)).toContain(kind);
    expect(findings.find((finding) => finding.class === kind)).toMatchObject({ where: "body", lines: [REPORT.body.split("\n").length + 1] });
    /* The answer names the class and the line, and never repeats the value. */
    expect(JSON.stringify(refused)).not.toContain(line);
  }
  expect(fs.readdirSync(sandbox)).toEqual([]);
});

test("a clean report is stored under the digest of its exact text", async () => {
  const h = harness();
  const preview = await h.call(REPORTER, { action: "preview", ...REPORT });
  expect(preview).toMatchObject({ ok: true, state: "preview", title: REPORT.title, body: REPORT.body, digest: issueReportDigest(REPORT) });
  expect(readIssueReportPreview(preview.digest as string, sandbox)).toMatchObject({ createdBy: "conversation_reporter", shownTo: [], state: "preview" });
  expect(h.published).toEqual([]);
});

test("the seat reads the preview back, and the approved digest files exactly that text, once", async () => {
  const h = harness();
  const digest = await previewed(h);

  const shown = await h.call(SEAT_CALLER, { action: "show", digest });
  expect(shown).toMatchObject({ ok: true, title: REPORT.title, body: REPORT.body, digest });

  const published = await h.call(SEAT_CALLER, { action: "publish", digest, approval: "Так, публікуй" });
  expect(published).toMatchObject({ ok: true, published: true, issueUrl: ISSUE_URL, state: "published" });
  expect(h.published).toEqual([{ ...REPORT, repository: REPOSITORY }]);
  expect(readIssueReportPreview(digest, sandbox)?.publication).toMatchObject({ by: SEAT, approval: "Так, публікуй", issueUrl: ISSUE_URL });

  /* A second publication of the same preview answers the issue that exists. */
  const again = await h.call(SEAT_CALLER, { action: "publish", digest, approval: "yes" });
  expect(again).toMatchObject({ ok: true, published: true, replay: true, issueUrl: ISSUE_URL });
  expect(h.published).toHaveLength(1);
});

test("a digest that does not match the approved preview is refused and nothing is filed", async () => {
  const h = harness();
  const digest = await previewed(h);
  await h.call(SEAT_CALLER, { action: "show", digest });

  /* The digest of an edited text nobody previewed. */
  const edited = issueReportDigest({ title: REPORT.title, body: `${REPORT.body}\nOne more sentence.` });
  expect(edited).not.toBe(digest);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest: edited, approval: "yes" }))
    .toMatchObject({ ok: false, code: "issue_report_digest_mismatch" });

  /* A stored preview whose text was changed under its digest. */
  const file = path.join(sandbox, `${digest}.json`);
  const stored = JSON.parse(fs.readFileSync(file, "utf8")) as { body: string };
  fs.writeFileSync(file, JSON.stringify({ ...stored, body: `${stored.body}\nSlipped in after approval.` }));
  expect(await h.call(SEAT_CALLER, { action: "publish", digest, approval: "yes" }))
    .toMatchObject({ ok: false, code: "issue_report_digest_mismatch" });

  expect(h.published).toEqual([]);
});

test("an edit is a new preview with a new digest, and the old approval does not carry over", async () => {
  const h = harness();
  const first = await previewed(h);
  await h.call(SEAT_CALLER, { action: "show", digest: first });
  const second = await previewed(h, { title: REPORT.title, body: `${REPORT.body}\nIt happened twice in one hour.` });
  expect(second).not.toBe(first);

  /* The seat has not read the edited text back, so it cannot have shown it. */
  expect(await h.call(SEAT_CALLER, { action: "publish", digest: second, approval: "yes" }))
    .toMatchObject({ ok: false, code: "issue_report_not_shown" });
  expect(h.published).toEqual([]);
});

test("only the seat itself publishes, and only with the operator's words", async () => {
  const h = harness();
  const digest = await previewed(h);
  await h.call(SEAT_CALLER, { action: "show", digest });

  for (const caller of [REPORTER, DEPUTY]) {
    expect(await h.call(caller, { action: "publish", digest, approval: "yes" }))
      .toMatchObject({ ok: false, code: "issue_report_publish_refused" });
  }
  expect(await h.call(SEAT_CALLER, { action: "publish", digest }))
    .toMatchObject({ ok: false, code: "issue_report_approval_required" });
  expect(await h.call(SEAT_CALLER, { action: "publish", digest, approval: "   " }))
    .toMatchObject({ ok: false, code: "issue_report_approval_required" });
  expect(h.published).toEqual([]);
});

test("a preview needs an identified session and a one-line title", async () => {
  const h = harness();
  expect(await h.call({ kind: "unidentified", conversationId: null, role: null }, { action: "preview", ...REPORT }))
    .toMatchObject({ ok: false, code: "issue_report_caller_unidentified" });
  expect(await h.call(REPORTER, { action: "preview", title: "two\nlines", body: REPORT.body }))
    .toMatchObject({ ok: false, code: "issue_report_invalid", details: { field: "title" } });
  expect(fs.readdirSync(sandbox)).toEqual([]);
});
