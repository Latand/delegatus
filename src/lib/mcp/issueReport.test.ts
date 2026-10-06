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
 * #2518 at the tool boundary: a Delegatus bug report is checked before it can
 * be previewed, and what is filed is the stored preview the operator approved,
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
        expect(url).toBe("/api/telegram/bot/agent?op=chats");
        await options.privacyRead!();
        return { chats: [] };
      },
    } : undefined;
    return createMcpToolService(viewerMcpBindings(undefined, control, domain as never), new MemoryMcpReceiptStore(), viewerMcpToolPolicy(domain as never));
  };
  let next = 0;
  const call = (caller: CallerAttribution, args: Record<string, unknown>) =>
    as(caller).callTool("issue_report", { clientRequestId: `issue-report-${next += 1}`, ...args }) as Promise<McpToolResult & Record<string, unknown>>;
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

test("Markdown markup, an uncommon top-level domain, a spaced folder and a quotation over lines are refused before any preview exists", async () => {
  const h = harness({ deny: { ...DENY, people: ["Ada"] } });
  const bodies: [string, string][] = [
    ["person", "A**da** observed the failure."],
    ["id", `The pipeline ${"dead"}**${"beef"}** stayed queued.`],
    ["domain", `The failure happened on ${"buildbox"}.**${"fr"}**.`],
    ["domain", `The failure happened on ${"buildbox"}.${"tools"}.`],
    ["domain", `The failure happened on ${"buildbox"}.${"xn--p1ai"}.`],
    ["domain", `The failure happened on ${"вузол"}.${"укр"}.`],
    ["path", `The evidence file is ${["", "My data", "notes.txt"].join("/")}.`],
    ["quote", "The operator said: \"restart\nevery agent\nnow\"."],
  ];
  for (const [kind, body] of bodies) {
    const refused = await h.call(REPORTER, { action: "preview", title: REPORT.title, body });
    expect(refused).toMatchObject({ ok: false, code: "issue_report_private_data" });
    expect((refused.details as { findings: { class: string }[] }).findings.map((finding) => finding.class)).toContain(kind);
  }
  expect(fs.readdirSync(sandbox)).toEqual([]);
});

/* The third review of #2518: each body below was stored. */
test("reference links and images, a host before a remark in brackets, bare absolute paths and a spaced quotation are refused before any preview exists", async () => {
  const h = harness({ deny: { accounts: ["claude-main-b"], people: ["Ada"], local: [], projects: [{ repository: "example/Artemis", names: ["Artemis"] }] } });
  const bodies: [string, string][] = [
    ["person", "A[da][ref] observed the failure.\n\n[ref]: #details"],
    ["account", "The launch picked claude-[main][ref]-b.\n\n[ref]: #details"],
    ["project", "The project Arte[mis][ref] failed to launch.\n\n[ref]: #details"],
    ["id", `The pipeline ${"dead"}[${"beef"}][ref] stayed queued.\n\n[ref]: #details`],
    ["domain", `The failure happened on ${"buildbox"}.[${"tools"}][ref].\n\n[ref]: #details`],
    ["path", `The evidence file is [${"/"}My][ref]/notes.txt.\n\n[ref]: #details`],
    ["image", "![board][ref]\n\n[ref]: shot.png"],
    ["domain", `The failing host was ${"buildbox"}.${"tools"} (offline).`],
    ["domain", `The failing host was ${"buildbox"}.${"fr"} (offline).`],
    ["path", `The evidence file is ${["", "notes.txt"].join("/")}.`],
    ["path", `The evidence file is ${["", "My's data", "notes.txt"].join("/")}.`],
    ["path", `The evidence file is ${["C:", "Evidence", "notes.txt"].join("/")}.`],
    ["quote", "The operator said: \" restart every agent now \"."],
    ["quote", "The operator said: ' restart every agent now '."],
  ];
  for (const [kind, body] of bodies) {
    const refused = await h.call(REPORTER, { action: "preview", title: REPORT.title, body });
    expect(refused).toMatchObject({ ok: false, code: "issue_report_private_data" });
    expect((refused.details as { findings: { class: string }[] }).findings.map((finding) => finding.class)).toContain(kind);
  }
  expect(fs.readdirSync(sandbox)).toEqual([]);
  /* A reference link to Delegatus's own code, a call and a marked term are stored. */
  expect(await h.call(REPORTER, {
    action: "preview", title: REPORT.title,
    body: `${REPORT.body}\nSee [the bindings][ref]: Date.now() was read and the state "delivered" was kept.\n\n[ref]: src/lib/mcp/bindings.ts`,
  })).toMatchObject({ ok: true, state: "preview" });
});

test("a clean report is stored under the digest of its exact text", async () => {
  const h = harness();
  const preview = await h.call(REPORTER, { action: "preview", ...REPORT });
  expect(preview).toMatchObject({ ok: true, state: "preview", title: REPORT.title, body: REPORT.body, digest: issueReportDigest(REPORT) });
  expect(readIssueReportPreview(preview.digest as string, sandbox)).toMatchObject({ createdBy: "conversation_reporter", shown: [], state: "preview" });
  expect(h.published).toEqual([]);
});

test("domains disguised as calls or files, UNC paths, nested quotes and spaced names never create a preview", async () => {
  const h = harness({ deny: {
    accounts: ["Account Bee"], people: ["Person Bee"], local: [],
    projects: [{ repository: null, names: ["Project Bee"] }],
  } });
  const cases: [string, string][] = [
    ["domain", `The failing host was ${"buildbox"}.${"tools"}(offline).`],
    ["domain", `The failing host was ${"buildbox"}.${"sh"}.`],
    ["path", `The evidence is on ${["", "", "filesrv", "private", "notes.txt"].join("/")}.`],
    ["path", `The evidence is on ${["", "", "filesrv", "private", "notes.txt"].join("\\")}.`],
    ["quote", "- > restart every agent now"],
    ["quote", "1. - > restart every agent now"],
    ["quote", "<blockquote>restart every agent now</blockquote>"],
  ];
  for (const [kind, name] of [["person", "Person Bee"], ["account", "Account Bee"], ["project", "Project Bee"]]) {
    for (const space of ["  ", "\n", "\t", "&nbsp;&nbsp;"]) cases.push([kind, `${name.replace(" ", space)} observed the refusal.`]);
  }
  const encodings = [
    (text: string) => text,
    (text: string) => [...text].map((char) => `&#${char.codePointAt(0)};`).join(""),
    (text: string) => encodeURIComponent(text),
    (text: string) => `**${text}**`,
  ];
  for (const [kind, body] of cases) for (const encode of encodings) {
    const refused = await h.call(REPORTER, { action: "preview", title: REPORT.title, body: encode(body) });
    expect(refused).toMatchObject({ ok: false, code: "issue_report_private_data" });
    expect((refused.details as { findings: { class: string }[] }).findings.map((finding) => finding.class)).toContain(kind);
    expect(fs.readdirSync(sandbox)).toEqual([]);
  }
  expect(h.published).toEqual([]);
  expect(await h.call(REPORTER, {
    action: "preview", title: REPORT.title,
    body: `${REPORT.body}\nSee docs/design/agent-prompt-contract.md and scripts/gate-slot.sh; Date.now() and rows.map(render) returned.\nThe operator asked for every agent to be restarted at once.`,
  })).toMatchObject({ ok: true, state: "preview" });
});

test("plan data, token usage and a one-digit port are refused before a preview", async () => {
  const h = harness();
  for (const [kind, body] of [
    ["usage", "The account has a free plan."],
    ["usage", "The account tier is free."],
    ["usage", "The account has a free-tier subscription."],
    ["usage", "The usage observation was 120 tokens."],
    ["usage", "The quota remaining was 120."],
    ["port", "The listener used port 9."],
    ["port", "The listener used port: 9."],
  ]) {
    const refused = await h.call(REPORTER, { action: "preview", title: REPORT.title, body });
    expect(refused).toMatchObject({ ok: false, code: "issue_report_private_data" });
    expect((refused.details as { findings: { class: string }[] }).findings.map((finding) => finding.class)).toContain(kind);
    expect(fs.readdirSync(sandbox)).toEqual([]);
  }
  expect(h.published).toEqual([]);
  expect(await h.call(REPORTER, {
    action: "preview", title: REPORT.title,
    body: "The usage meter never refreshed. The investigation plan is to check its update path. The listener refused a connection.",
  })).toMatchObject({ ok: true, state: "preview" });
});

test("account observations, qualified token counts and bare endpoints never create a preview", async () => {
  const h = harness();
  const cases: [string, string][] = [
    ["usage", "The account used 93%."],
    ["usage", '{"usedPercent":93,"resetsAt":"2026-10-07T00:00:00Z"}'],
    ["usage", "The account has ChatGPT Plus."],
    ["usage", "The plan is Claude Max."],
    ["usage", '{"planType":"pro"}'],
    ["usage", "The session used 120000 input tokens."],
    ["port", "The listener bound to :8898."],
    ["port", "The launch ran on buildbox:8898."],
    ["port", '{"port":8898}'],
    ["port", "The listener port was 8898."],
    ["path", "The transcript is stored at \\notes.txt."],
    ["path", "The transcript is stored at \\private."],
    ["path", "The transcript is stored at C:notes.txt."],
  ];
  for (const [kind, body] of cases) for (const encode of [
    (text: string) => text,
    (text: string) => encodeURIComponent(text),
    (text: string) => [...text].map((char) => `&#${char.codePointAt(0)};`).join(""),
    (text: string) => `**${text}**`,
  ]) {
    const refused = await h.call(REPORTER, { action: "preview", title: REPORT.title, body: encode(body) });
    expect(refused).toMatchObject({ ok: false, code: "issue_report_private_data" });
    expect((refused.details as { findings: { class: string }[] }).findings.map((finding) => finding.class)).toContain(kind);
    expect(fs.readdirSync(sandbox)).toEqual([]);
  }
  /* A preview admitted by an older detector is checked again on publication. */
  for (const [, body] of cases) {
    const { digest } = recordIssueReportPreview({ title: REPORT.title, body }, REPORTER.conversationId!, { directory: sandbox });
    const replies = await shown(h, digest);
    h.operatorSays(replies.en);
    expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: false, code: "issue_report_private_data" });
    expect(readIssueReportPreview(digest, sandbox)?.state).toBe("preview");
  }
  expect(h.published).toEqual([]);
  expect(await h.call(REPORTER, {
    action: "preview", title: REPORT.title,
    body: "The check ran at 12:30 and took 20 seconds. The usedPercent field failed to refresh. The investigation plan is to read the event stream.",
  })).toMatchObject({ ok: true, state: "preview" });
});

test("privacy bypasses are refused before storage and rechecked before publication", async () => {
  const h = harness({ deny: {
    accounts: ["Account Bee"], people: ["Person Bee"], local: [],
    projects: [{ repository: null, names: ["Project Bee"] }],
  } });
  const cases: [string, string][] = [
    ["person", "Person<br>Bee observed the refusal."],
    ["account", "Account<br/>Bee observed the refusal."],
    ["project", "Project<br />Bee observed the refusal."],
    ["person", "<div>Person</div><div>Bee observed the refusal.</div>"],
    ["person", "Per~son~ Bee observed the refusal."],
    ...["test", "invalid", "example", "localhost", "alt"].map((ending): [string, string] => ["domain", `The failing hostname was ${"remote-worker"}.${ending}.`]),
    ["host", "The failing hostname is remote-worker."],
    ["host", "The hostname was `remote-worker`."],
    ["host", "The remote host: buildbox failed."],
    ["host", "HOST=buildbox"],
    ["host", '{"hostname":"buildbox"}'],
    ["account", "username: builduser"],
    ["account", "account_name: user-alias"],
    ["account", '{"user_name":"builduser"}'],
    ["quote", "The operator wrote: `restart every agent now`."],
    ["quote", "The operator wrote `restart every agent now`."],
    ["quote", "Оператор написав `перезапусти всіх агентів зараз`."],
    ["quote", "The operator said: ‹restart every agent now›."],
    ["quote", "Оператор написав: `перезапусти всіх агентів зараз`."],
    ["quote", "Користувач сказав: ‹перезапусти всіх агентів зараз›."],
    ["path", `The evidence is ${["~other-user", "private", "notes.txt"].join("/")}.`],
    ["path", `The evidence is [${["~दूसरा", "private", "notes.txt"].join("/")}](#evidence).`],
    ["path", `The evidence is <code>${["~other+user", "private", "notes.txt"].join("/")}</code>.`],
    ["path", `The evidence is [${["~other-user", "private", "notes.txt"].join("/")}](#evidence).`],
    ["usage", "The account has 1M input tokens."],
    ["usage", "The account has 1.5k output tokens."],
    ["usage", "The account cost USD 20 per month."],
    ["usage", "The subscription cost 20 dollars per month."],
    ["usage", "The subscription costs 20 per month."],
    ["usage", "The account cost USD20."],
    ["usage", "The subscription cost £20."],
    ["port", "The listener bound to : 8898."],
    ["port", "The endpoint was remote-worker: 8898."],
  ];
  const forms = [(body: string) => body, encodeURIComponent, (body: string) => [...body].map((char) => `&#${char.codePointAt(0)};`).join("")];
  for (const [kind, body] of cases) for (const encode of forms) {
    const report = { title: REPORT.title, body: encode(body) };
    const refused = await h.call(REPORTER, { action: "preview", ...report });
    expect(refused).toMatchObject({ ok: false, code: "issue_report_private_data" });
    expect((refused.details as { findings: { class: string }[] }).findings.map((finding) => finding.class)).toContain(kind);
    expect(JSON.stringify(refused)).not.toContain(body);
    expect(fs.readdirSync(sandbox)).toEqual([]);
  }
  /* Stored by an older version: publication must refuse every form too. */
  for (const [, body] of cases) for (const encode of forms) {
    const report = { title: REPORT.title, body: encode(body) };
    const { digest } = recordIssueReportPreview(report, REPORTER.conversationId!, { directory: sandbox });
    const replies = await shown(h, digest);
    h.operatorSays(replies.en);
    const refused = await h.call(SEAT_CALLER, { action: "publish", digest });
    expect(refused).toMatchObject({ ok: false, code: "issue_report_private_data" });
    expect(JSON.stringify(refused)).not.toContain(body);
    expect(readIssueReportPreview(digest, sandbox)).toMatchObject({ state: "preview" });
    expect(readIssueReportPreview(digest, sandbox)?.publication).toBeUndefined();
  }
  expect(h.published).toEqual([]);
  const clean = {
    title: REPORT.title,
    body: "README.md describes Date.now() and src/lib/mcp/bindings.ts. The tool returned `connection refused during startup`. The check ran at 12:30 and took 20 seconds. Symptom: the listener refused a connection.",
  };
  const digest = await previewed(h, clean);
  const replies = await shown(h, digest);
  h.operatorSays(replies.en);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: true, published: true });
  expect(h.published).toEqual([{ ...clean, repository: REPOSITORY }]);
});

test("attributed code quotes, complete home expressions, spaced absolute paths and remote machine names cannot cross either privacy boundary", async () => {
  const h = harness({ deny: { accounts: [], people: [], local: [], projects: [] } });
  const cases: [string, string][] = [
    ["quote", "The operator replied with `restart every agent now`."],
    ["quote", "The operator’s exact reply was `restart every agent now`."],
    ["quote", "The user's reply was `restart every agent now`."],
    ["quote", "The human said exactly: `restart every agent now`."],
    ["quote", "The operator replied using `restart every agent now`."],
    ["quote", "The operator said exactly the following: `restart every agent now`."],
    ["quote", "The operator's exact words: `restart every agent now`."],
    ["quote", "The operator replied with <code>restart every agent now</code>."],
    ["quote", "Оператор відповів словами `перезапусти всіх агентів зараз`."],
    ["quote", "Користувач відповіла так: `перезапусти всіх агентів зараз`."],
    ["quote", "Точна відповідь оператора була `перезапусти всіх агентів зараз`."],
    ...["~", "~+", "~-", "~reportuser", "~інший", "~दूसरा", "~other+user", "~other.user"].map((home): [string, string] => ["path", `The state directory is \`${home}\`.`]),
    ["path", "The state directory is (~reportuser), and the read failed."],
    ["path", "The state directory is '~'."],
    ["path", "The state directory is **~reportuser**."],
    ["path", `The log is in \`${["", " My notes", "log.txt"].join("/")}\`.`],
    ["path", `The log is in '${["", " My notes", "log.txt"].join("/")}'.`],
    ["path", `The log is in “${["", " Мої записи", "звіт.txt"].join("/")}”.`],
    ["path", `The log is in \`${["", " leading.txt"].join("/")}\`.`],
    ["path", `The log is in <code>${["", " My notes", "log.txt"].join("/")}</code>.`],
    ["path", `The log is in \` ${["", " leading.txt"].join("/")} \`.`],
    ["path", `The log is in \`${["", " "].join("/")}\`.`],
    ["domain", `The failure occurred on ${["buildbox", "node", "consul"].join(".")}.`],
    ["domain", `The failure occurred on ${["buildbox", "default", "svc"].join(".")}.`],
    ["host", "The machine name is runner-q."],
    ["host", "The node name was `runner-q`."],
    ["host", '{"machine_name":"runner-q"}'],
    ["host", '{"node_name":"runner-q"}'],
    ["host", "Ім’я машини: runner-q"],
    ["host", "Ім’я вузла: runner-q"],
  ];
  const forms = [(body: string) => body, encodeURIComponent, (body: string) => [...body].map((char) => `&#${char.codePointAt(0)};`).join("")];
  for (const [kind, body] of cases) for (const encode of forms) {
    const report = { title: REPORT.title, body: encode(body) };
    const refused = await h.call(REPORTER, { action: "preview", ...report });
    expect(refused).toMatchObject({ ok: false, code: "issue_report_private_data" });
    expect((refused.details as { findings: { class: string }[] }).findings.map((finding) => finding.class)).toContain(kind);
    expect(fs.readdirSync(sandbox)).toEqual([]);
    expect(JSON.stringify(refused)).not.toContain(body);
  }
  for (const [, body] of cases) for (const encode of forms) {
    const { digest } = recordIssueReportPreview({ title: REPORT.title, body: encode(body) }, REPORTER.conversationId!, { directory: sandbox });
    const replies = await shown(h, digest);
    h.operatorSays(replies.uk);
    expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: false, code: "issue_report_private_data" });
    expect(readIssueReportPreview(digest, sandbox)).toMatchObject({ state: "preview" });
    expect(readIssueReportPreview(digest, sandbox)?.publication).toBeUndefined();
  }
  expect(h.published).toEqual([]);
  const clean = { title: REPORT.title, body: "The error was `connection refused during startup`. Date.now() and rows.map(render) returned. See src/lib/mcp/bindings.ts. The **read/write** split and ~~removed~~ state differ; either / or was shown." };
  const digest = await previewed(h, clean);
  h.operatorSays((await shown(h, digest)).en);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: true, published: true });
  expect(h.published).toEqual([{ ...clean, repository: REPOSITORY }]);
});

const additionalPrivateReports: [string, string][] = [
  ["path", `The transcript is file://${["", "var", "log", "delegatus", "transcript.jsonl"].join("/")}.`],
  ["path", `The transcript is FILE:${["", "var", "log", "delegatus", "transcript.jsonl"].join("/")}.`],
  ["quote", "The operator wrote in their message `restart every agent now`."],
  ["quote", "The operator told me `restart every agent now`."],
  ["quote", "The operator wrote <q>restart every agent now</q>."],
  ["quote", "Оператор написав у своєму повідомленні `перезапусти всіх агентів зараз`."],
  ["quote", "Користувач сказала мені <q>перезапусти всіх агентів зараз</q>."],
  ["quote", "The operator wrote in\nthe chat `restart every agent now`."],
  ["quote", "The operator told me in\r\nthe chat <q>restart every agent now</q>."],
  ["quote", "Оператор написав у\nсвоєму повідомленні `перезапусти всіх агентів зараз`."],
  ["quote", "Користувач сказала мені у\r\nповідомленні <q>перезапусти всіх агентів зараз</q>."],
  ["quote", "<q>restart every agent now</q>"],
  ["quote", "<Q class=\"quotation\">restart every agent now</Q>"],
  ["quote", "<q><b>перезапусти</b> всіх агентів зараз</q>"],
  ["host", "Machine: remote-worker"],
  ["host", "node = remote-worker"],
  ["host", '{"machine":"remote-worker"}'],
  ["host", '{"node":"remote-worker"}'],
  ["host", "Машина: remote-worker"],
  ["host", "Вузол = remote-worker"],
];
const additionalPrivateForms = additionalPrivateReports.flatMap(([kind, body], index) =>
  [body, encodeURIComponent(body), [...body].map((char) => `&#${char.codePointAt(0)};`).join("")]
    .map((encoded, form) => ({ kind, body: encoded, index, form })));

test.each(additionalPrivateForms)("private report $index form $form is refused before preview storage", async ({ kind, body }) => {
  const h = harness({ deny: { accounts: [], people: [], local: [], projects: [] } });
  const refused = await h.call(REPORTER, { action: "preview", title: REPORT.title, body });
  expect(refused).toMatchObject({ ok: false, code: "issue_report_private_data" });
  expect((refused.details as { findings: { class: string }[] }).findings.map((finding) => finding.class)).toContain(kind);
  expect(fs.readdirSync(sandbox)).toEqual([]);
  expect(h.published).toEqual([]);
});

test.each(additionalPrivateForms)("legacy private report $index form $form is refused before publication claim", async ({ kind, body }) => {
  const h = harness({ deny: { accounts: [], people: [], local: [], projects: [] } });
  const { digest } = recordIssueReportPreview({ title: REPORT.title, body }, REPORTER.conversationId!, { directory: sandbox });
  h.operatorSays((await shown(h, digest)).en);
  const refused = await h.call(SEAT_CALLER, { action: "publish", digest });
  expect(refused).toMatchObject({ ok: false, code: "issue_report_private_data" });
  expect((refused.details as { findings: { class: string }[] }).findings.map((finding) => finding.class)).toContain(kind);
  expect(readIssueReportPreview(digest, sandbox)).toMatchObject({ state: "preview" });
  expect(readIssueReportPreview(digest, sandbox)?.publication).toBeUndefined();
  expect(h.published).toEqual([]);
});

test("unpopulated machine fields and technical spans after a speech sentence stay publishable", async () => {
  const h = harness({ deny: { accounts: [], people: [], local: [], projects: [] } });
  const report = { title: REPORT.title, body: "The machine field and node field were missing. The operator asked for an investigation.\nThe error was `connection refused during startup`; see src/lib/mcp/bindings.ts:1767." };
  const digest = await previewed(h, report);
  h.operatorSays((await shown(h, digest)).uk);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: true, published: true });
  expect(h.published).toEqual([{ ...report, repository: REPOSITORY }]);
});

const unavailableNameSources = ["chats throws", "chats malformed", "messages throws", "messages malformed", "messages pagination malformed"];
function unavailableNameReader(mode: string) {
  return async (url: string): Promise<Record<string, unknown>> => {
    if (url.endsWith("op=chats") && mode.startsWith("messages")) return { chats: [{ chat: "allowed-chat", postAllowed: true }] };
    if (mode.endsWith("throws")) throw new Error("private-source-error-must-stay-private");
    if (mode === "messages pagination malformed") return { messages: [] };
    return {};
  };
}

test.each(unavailableNameSources)("unavailable %s refuses preview without storage or private error text", async (mode) => {
  const h = harness({ controlRead: unavailableNameReader(mode) });
  const refused = await h.call(REPORTER, { action: "preview", title: REPORT.title, body: "Ada observed the failed launch." });
  expect(refused).toMatchObject({ ok: false, code: "issue_report_privacy_unavailable", retryable: true });
  expect(JSON.stringify(refused)).not.toContain("private-source-error-must-stay-private");
  expect(fs.readdirSync(sandbox)).toEqual([]);
  expect(h.published).toEqual([]);
});

test.each(unavailableNameSources)("unavailable %s refuses an approved legacy preview before its claim", async (mode) => {
  const h = harness({ controlRead: unavailableNameReader(mode) });
  const { digest } = recordIssueReportPreview({ title: REPORT.title, body: "Ada observed the failed launch." }, REPORTER.conversationId!, { directory: sandbox });
  h.operatorSays((await shown(h, digest)).uk);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: false, code: "issue_report_privacy_unavailable", retryable: true });
  expect(readIssueReportPreview(digest, sandbox)).toMatchObject({ state: "preview" });
  expect(readIssueReportPreview(digest, sandbox)?.publication).toBeUndefined();
  expect(h.published).toEqual([]);
});

test("available empty sources allow reports, recovered people sources reject known names", async () => {
  let available = false;
  const h = harness({ controlRead: async (url) => {
    if (!available) throw new Error("privacy read unavailable");
    return url.endsWith("op=chats")
      ? { chats: [{ chat: "allowed-chat", postAllowed: true }] }
      : { messages: [{ fromName: "Ada" }], hasMore: false, nextCursor: null };
  } });
  expect(await h.call(REPORTER, { action: "preview", ...REPORT })).toMatchObject({ ok: false, code: "issue_report_privacy_unavailable" });
  available = true;
  expect(await h.call(REPORTER, { action: "preview", title: REPORT.title, body: "Ada observed the failed launch." })).toMatchObject({ ok: false, code: "issue_report_private_data" });
  expect(fs.readdirSync(sandbox)).toEqual([]);
  const empty = harness({ controlRead: async () => ({ bot: { connected: false }, chats: [] }) });
  const digest = await previewed(empty);
  empty.operatorSays((await shown(empty, digest)).en);
  expect(await empty.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: true, published: true });
  expect(empty.published).toEqual([{ ...REPORT, repository: REPOSITORY }]);
});

test.each(["fifth chat", "older page", "remote without seat", "aliased display name"])("known private names from %s are refused at both boundaries", async (source) => {
  if (source === "remote without seat") fs.writeFileSync(path.join(privacyState, "project-remotes.json"), JSON.stringify({
    schemaVersion: 1, remotes: { [`repo-${"1".repeat(32)}`]: `https://${["github", "com"].join(".")}/acme/HiddenWorkshop.git` },
  }));
  if (source === "aliased display name") fs.writeFileSync(path.join(privacyState, "project-aliases.json"), JSON.stringify({
    schemaVersion: 1, aliases: { "old-project": `repo-${"1".repeat(32)}` }, displayNames: { "old-project": "HiddenWorkshop" },
  }));
  const h = harness({ controlRead: async (url) => {
    if (url.endsWith("op=chats")) return { chats: Array.from({ length: source === "fifth chat" ? 5 : 1 }, (_, index) => ({ chat: `allowed-chat-${index}`, postAllowed: true })) };
    const params = new URLSearchParams(url.split("?")[1]);
    if (source === "older page" && !params.has("cursor")) return { messages: [], hasMore: true, nextCursor: "older" };
    return { messages: source === "older page" || params.get("chat") === "allowed-chat-4" ? [{ fromName: "Person Later" }] : [], hasMore: false, nextCursor: null };
  } });
  const projectSource = source === "remote without seat" || source === "aliased display name";
  const bodies = projectSource ? ["HiddenWorkshop observed the failure.", ...(source === "remote without seat" ? ["acme/HiddenWorkshop observed the failure."] : [])] : ["Person Later observed the failure."];
  for (const body of bodies) {
    const report = { title: REPORT.title, body };
    const refused = await h.call(REPORTER, { action: "preview", ...report });
    expect(refused).toMatchObject({ ok: false, code: "issue_report_private_data" });
    expect((refused.details as { findings: { class: string }[] }).findings.map((finding) => finding.class)).toContain(projectSource ? "project" : "person");
    expect(fs.readdirSync(sandbox)).toEqual([]);
  }
  for (const body of bodies) {
    const { digest } = recordIssueReportPreview({ title: REPORT.title, body }, REPORTER.conversationId!, { directory: sandbox });
    h.operatorSays((await shown(h, digest)).en);
    expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: false, code: "issue_report_private_data" });
    expect(readIssueReportPreview(digest, sandbox)?.publication).toBeUndefined();
  }
  expect(h.published).toEqual([]);
});

test.each(["truncated chats", "missing cursor", "repeated cursor"])("incomplete %s refuses both privacy boundaries", async (mode) => {
  const h = harness({ controlRead: async (url) => url.endsWith("op=chats")
    ? { chats: [{ chat: "allowed-chat", postAllowed: true }], ...(mode === "truncated chats" ? { truncated: 1 } : {}) }
    : { messages: [], hasMore: true, nextCursor: mode === "missing cursor" ? null : "repeated" },
  });
  expect(await h.call(REPORTER, { action: "preview", ...REPORT })).toMatchObject({ ok: false, code: "issue_report_privacy_unavailable", retryable: true });
  expect(fs.readdirSync(sandbox)).toEqual([]);
  const { digest } = recordIssueReportPreview(REPORT, REPORTER.conversationId!, { directory: sandbox });
  h.operatorSays((await shown(h, digest)).uk);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: false, code: "issue_report_privacy_unavailable", retryable: true });
  expect(readIssueReportPreview(digest, sandbox)?.publication).toBeUndefined();
  expect(h.published).toEqual([]);
});

test.each(["claude-accounts.json", "codex-accounts.json", "copilot-accounts.json", "project-aliases.json", "project-remotes.json"])("unreadable %s refuses both privacy boundaries", async (filename) => {
  fs.writeFileSync(path.join(privacyState, filename), "{");
  const h = harness({ controlRead: async () => ({ chats: [] }) });
  expect(await h.call(REPORTER, { action: "preview", ...REPORT })).toMatchObject({ ok: false, code: "issue_report_privacy_unavailable", retryable: true });
  expect(fs.readdirSync(sandbox)).toEqual([]);
  const { digest } = recordIssueReportPreview(REPORT, REPORTER.conversationId!, { directory: sandbox });
  h.operatorSays((await shown(h, digest)).en);
  expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: false, code: "issue_report_privacy_unavailable", retryable: true });
  expect(readIssueReportPreview(digest, sandbox)?.publication).toBeUndefined();
  expect(h.published).toEqual([]);
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

test("a withdrawal or edit during async privacy reads prevents a claim and publication", async () => {
  for (const [index, words] of ["Wait, do not publish", "Change the title first", "Ні, не публікуй", "Зміни текст спочатку"].entries()) {
    let holdRead = false;
    let release = () => {};
    let entered = () => {};
    const held = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const h = harness({ privacyRead: async () => { if (holdRead) { entered(); await held; } } });
    const report = { ...REPORT, body: `${REPORT.body}\nReproduction ${index + 1}.` };
    const digest = await previewed(h, report);
    const replies = await shown(h, digest);
    h.operatorSays(replies.en);
    holdRead = true;
    const publishing = h.call(SEAT_CALLER, { action: "publish", digest });
    try {
      await started;
      h.operatorSays(words);
    } finally { release(); }
    expect(await publishing).toMatchObject({ ok: false, code: "issue_report_approval_required" });
    expect(h.published).toEqual([]);
    expect(readIssueReportPreview(digest, sandbox)?.state).toBe("preview");
    expect(readIssueReportPreview(digest, sandbox)?.publication).toBeUndefined();
    /* A fresh approval still files the same preview exactly once. */
    h.operatorSays(replies.uk);
    expect(await h.call(SEAT_CALLER, { action: "publish", digest })).toMatchObject({ ok: true, published: true });
    expect(h.published).toEqual([{ ...report, repository: REPOSITORY }]);
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
test("encoded values, real id and host forms, known names and quotations are refused before any preview exists", async () => {
  const deny: PublicDenyList = { accounts: [], people: ["Ada", "Ostap Vyshnia"], local: [], projects: [{ repository: "example/Artemis", names: ["Artemis"] }] };
  const h = harness({ deny });
  const slash = "&#47;";
  const cases: [string, string][] = [
    ["home_path", `The transcript is under ${["", "home", "someone", "notes.md"].join(slash)}.`],
    ["person", "Ostap&#32;Vyshnia observed the refusal."],
    ["domain", `It failed on ${"buildbox"}.${"fr"}.`],
    ["ip", `It failed at ${"fd00"}::${"1234"}.`],
    ["path", `The state is stored at ${["", "дані", "особисте", "звіт.json"].join("/")}.`],
    ["id", `The pipeline ${"1234" + "5678"} failed.`],
    ["id", `The pipeline ${"dead" + "beef"} failed.`],
    ["person", "Ada observed the refusal."],
    ["project", "The project Artemis failed to launch."],
    ["quote", "The operator said: \"restart every agent now\"."],
    ["quote", "The operator said: “restart every agent now”."],
  ];
  for (const [kind, line] of cases) {
    const refused = await h.call(REPORTER, { action: "preview", title: REPORT.title, body: `${REPORT.body}\n${line}` });
    expect(refused).toMatchObject({ ok: false, code: "issue_report_private_data" });
    const findings = (refused.details as { findings: { class: string }[] }).findings;
    expect(findings.map((finding) => finding.class)).toContain(kind);
    expect(JSON.stringify(refused)).not.toContain(line);
  }
  expect(fs.readdirSync(sandbox)).toEqual([]);
  /* The same report in the reporter's own words, naming Delegatus, is stored. */
  expect(await h.call(REPORTER, { action: "preview", title: REPORT.title, body: `${REPORT.body}\nThe operator asked Delegatus to restart every agent.` }))
    .toMatchObject({ ok: true, state: "preview" });
});

/* Review finding 7: two publications of one digest both reached the forge. */
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
