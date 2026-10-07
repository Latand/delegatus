import { afterAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/* A stored lesson stays on this machine: the linked board's wire, the bridge
   and issue reports, and the publication privacy gate all withhold or refuse
   its text, while the lesson's own record is untouched. The state directory
   and the scratch repository are private to this file. */
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "llv-role-memory-egress-"));
process.env.LLV_STATE_DIR = path.join(sandbox, "state");
afterAll(() => fs.rmSync(sandbox, { recursive: true, force: true }));

const { leaveLessons, lessonPublicationEnv, projectView, recordLessonRequest, storedLessonTexts, withoutStoredLessons, WITHHELD_LESSON: WITHHELD_LESSON_TEXT } = await import("./roleStore");
const { outboundTask } = await import("@/lib/links/taskFeed");
const { renderReport, renderPlain } = await import("@/lib/bridge/reportRender");
const { scrubIssueReport } = await import("@/lib/issueReports/scrub");
const { EMPTY_DENY_LIST } = await import("@/lib/bridge/publicSafe");
type BoardTask = import("@/lib/tasks/types").BoardTask;

const PROJECT = "egress-trial";
const RULE = "When a change adds a branch for empty or missing input, write the test for that branch in the same commit.";
const WHY = "Review failed on an untested empty-input path in the parser.";
/* What an agent might write: the rule quoted with its own case, spacing and punctuation. */
const QUOTED = `Done. Applied ${RULE.toUpperCase().replace(", ", " -- ")}`;

recordLessonRequest({ pipelineId: "p-egress", stageId: "fix", attempt: 1, project: PROJECT, roleId: "builder", conversationId: "conversation_egress", at: "2026-10-07T12:00:00.000Z" });
const [left] = leaveLessons({ request: { pipelineId: "p-egress", stageId: "fix", attempt: 1 },
  source: { project: PROJECT, pipelineId: "p-egress", stageId: "fix", attempt: 1, roleId: "builder", fixRound: true, conversationId: "conversation_egress" },
  lessons: [{ scope: "role", rule: RULE, why: WHY }], none: null }).left;

test("outgoing text withholds a quoted lesson and its why; the lesson's record keeps them", () => {
  expect(storedLessonTexts()).toEqual([RULE, WHY]);
  const out = withoutStoredLessons(`${QUOTED}\nWhy: ${WHY.toLowerCase()}`);
  expect(out).toBe("Done. Applied [learned rule].\nWhy: [learned rule].");
  expect(withoutStoredLessons("Nothing learned here.")).toBe("Nothing learned here.");
  expect(projectView(PROJECT).scopes.find((scope) => scope.roleId === "builder")!.active).toEqual([expect.objectContaining({ id: left!.id, rule: RULE, why: WHY })]);
});

test("a task leaves for a linked board without the lesson its text or details quote", () => {
  const task = { id: "task-1", project: PROJECT, text: QUOTED, details: `Notes: ${RULE}`, status: "inbox" } as unknown as BoardTask;
  const outbound = outboundTask(task);
  expect(outbound.text).toBe("Done. Applied [learned rule].");
  expect(outbound.details).toBe("Notes: [learned rule].");
  expect(task.text).toBe(QUOTED);
  const plain = { ...task, text: "Fix the parser", details: undefined } as unknown as BoardTask;
  expect(outboundTask(plain)).toBe(plain);
});

test("bridge and issue reports drop a quoted lesson as private text", () => {
  const deny = { ...EMPTY_DENY_LIST, lessons: storedLessonTexts() };
  const { cut, warnings, dropped } = renderReport({ class: "status", name: "Delegatus", at: new Date("2026-10-07T12:00:00Z"), locale: "en", timeZone: "Europe/Kyiv",
    summary: QUOTED, sections: { inProgress: ["the parser fix", `follow ${RULE}`] }, deny });
  const plain = renderPlain(cut);
  expect(plain).not.toContain("WRITE THE TEST");
  expect(plain.toLowerCase()).not.toContain("write the test for that branch");
  expect(plain).toContain("the parser fix");
  expect(dropped.lesson).toBe(2);
  expect(warnings.join(" ")).toContain("a learned rule");
  expect(scrubIssueReport({ title: "Parser bug", body: `Repro: ${QUOTED}` }, deny).map((finding) => finding.class)).toContain("lesson");
});

test("the publication privacy gate refuses a change that carries a stored lesson", () => {
  const env = lessonPublicationEnv();
  const file = env.LLV_PRIVACY_KNOWN_VALUES_FILE!;
  expect(file.startsWith(path.join(process.env.LLV_STATE_DIR!, "role-memory") + path.sep)).toBe(true);
  expect(fs.statSync(file).mode & 0o777).toBe(0o600);
  expect(fs.readFileSync(file, "utf8")).toBe(`${RULE}\n${WHY}\n`);
  const repository = path.join(sandbox, "repository");
  fs.mkdirSync(repository);
  fs.writeFileSync(path.join(repository, "clean.md"), "The parser returns null for empty input.\n");
  fs.writeFileSync(path.join(repository, "quoted.md"), `Notes\n\n${QUOTED}\n`);
  const gate = (paths: string[]) => spawnSync(process.execPath, [path.resolve(import.meta.dir, "../../../scripts/privacy-publication-gate.ts"), "--repository", repository, "--paths", ...paths], {
    cwd: repository, encoding: "utf8", env: { ...process.env, ...env, LLV_PRIVACY_KNOWN_VALUES: "", NO_COLOR: "1" },
  });
  const refused = gate(["quoted.md"]);
  expect(refused.status).toBe(1);
  expect(refused.stdout).toContain("known_value: 1");
  expect(refused.stdout).not.toContain("WRITE THE TEST");
  expect(gate(["clean.md"]).status).toBe(0);
}, 30_000);

const { parseLessons } = await import("./roleStage");
const { encodeTask } = await import("@/lib/links/taskWire");
const { prototypeReviewReplica } = await import("@/lib/prototypeReview/model");
const { AgentFeed } = await import("@/lib/links/agentFeed");
const { withAgentConfigSandbox } = await import("@/lib/runtime/agentConfigSandbox");
type FileEntry = import("@/lib/types").FileEntry;
type PrototypeReviewRound = import("@/lib/prototypeReview/types").PrototypeReviewRound;
type AgentRow = import("@/lib/links/agentFeed").AgentRow;

/* Invented ids in the wire's own shapes, assembled at run time. */
const uuid = (digit: string) => [digit.repeat(8), digit.repeat(4), `4${digit.repeat(3)}`, `8${digit.repeat(3)}`, digit.repeat(12)].join("-");
const WIRE_PROJECT = `repo-${"e".repeat(32)}`;
const SELF = { id: uuid("a"), prefix: "aaaaaaaa" };
const gateAt = (repository: string, args: string[], env: Record<string, string | undefined>) => spawnSync(process.execPath, [path.resolve(import.meta.dir, "../../../scripts/privacy-publication-gate.ts"), "--repository", repository, ...args], {
  cwd: repository, encoding: "utf8", env: { ...process.env, ...env, LLV_PRIVACY_KNOWN_VALUES: "", NO_COLOR: "1" },
});
let attempts = 1;
function store(lessons: { scope: "role" | "project" | "machine"; rule: string; why: string }[]) {
  attempts += 1;
  const request = { pipelineId: "p-egress", stageId: "fix", attempt: attempts };
  recordLessonRequest({ ...request, project: PROJECT, roleId: "builder", conversationId: `conversation_egress_${attempts}`, at: "2026-10-07T12:00:00.000Z" });
  return leaveLessons({ request, source: { ...request, project: PROJECT, roleId: "builder", fixRound: true, conversationId: `conversation_egress_${attempts}` }, lessons, none: null }).left;
}

test("every text of a task the linked board receives withholds a stored lesson: prototype titles, variants and decisions, original and replica", () => {
  const at = "2026-10-07T12:00:00.000Z";
  const round: PrototypeReviewRound = {
    id: `pr_${"b".repeat(32)}`, taskId: uuid("b"), project: WIRE_PROJECT, title: `Variants for: ${RULE}`, createdAt: at,
    source: { conversationId: null }, publicationKey: "private-key", inputDigest: "private-digest",
    variants: [{ number: 1, name: "Compact", description: `Shows ${RULE.toLowerCase()}`, frames: [{ caption: `Caption: ${WHY}`, image: { id: "c".repeat(64), mime: "image/png", bytes: 8 } }], videos: [] }],
    decision: { chosen: [1], comment: `Agreed. ${RULE}`, at, delivery: { state: "sent", clientMessageId: "m-1", conversationId: null, text: RULE } },
  };
  const original = { id: uuid("b"), project: WIRE_PROJECT, text: "Prototype the rules window", status: "inbox", placement: "unplaced", assignments: [],
    createdAt: at, updatedAt: at, prototypeReviews: [round] } as unknown as BoardTask;
  const replica = { id: uuid("c"), project: WIRE_PROJECT, text: "From a peer", status: "inbox", placement: "unplaced", assignments: [],
    createdAt: at, updatedAt: at, prototypeReviewReplica: { ...prototypeReviewReplica(original)!, rounds: prototypeReviewReplica(original)!.rounds.map((entry) => ({ ...entry, taskId: uuid("c") })) } } as unknown as BoardTask;
  const quotes = (value: unknown) => /write the test for that branch|untested empty-input path/i.test(JSON.stringify(value));
  for (const task of [original, replica]) {
    expect(quotes(encodeTask(task, SELF).row)).toBe(true);
    const { row } = encodeTask(outboundTask(task), SELF);
    expect("withheld" in row).toBe(false);
    expect(quotes(row)).toBe(false);
    expect(JSON.stringify(row)).toContain(WITHHELD_LESSON_TEXT);
  }
  /* The local records keep every text. */
  expect(original.prototypeReviews![0]!.title).toBe(`Variants for: ${RULE}`);
});

test("an agent's title on the linked board withholds a lesson its task's first line quotes, before the line is cut", () => {
  const at = Date.now();
  const task = { id: uuid("d"), project: WIRE_PROJECT, text: `Follow this before every push: ${RULE} That holds in every lane of the project.\nDetails`, chosen: true, status: "assigned",
    placement: "unplaced", assignments: [{ conversationId: "conversation_feed" }], createdAt: new Date(at).toISOString(), updatedAt: new Date(at).toISOString() } as unknown as BoardTask;
  const file = { conversationId: "conversation_feed", project: WIRE_PROJECT, path: "/sandbox/feed.jsonl", title: "", engine: "claude", model: "claude-opus-5",
    proc: "running", activity: "live", mtime: Math.floor(at / 1000), lastAgentWorkAt: at, pendingQuestion: null, waitingInput: null } as unknown as FileEntry;
  const page = new AgentFeed("role-memory", () => [file], () => [task] as never, () => []).page(null, new Set([WIRE_PROJECT]));
  const row = (page.rows as AgentRow[]).find((entry) => entry.task === task.id)!;
  expect(row.t).toStartWith("Follow this before every push: [learned rule]");
  expect(JSON.stringify(page).toLowerCase()).not.toContain("write the test");
});

test("short reasons and symbol-heavy rules are refused at leave_lesson; one stored before that is still withheld on every path", () => {
  const SHORT_RULE = "Guard each concurrent write to the shared store with the lock.";
  const SYMBOLS = "Use `a<b` && `c>d` || `e==f` -> `g!=h`;";
  const why = "Two writers raced on the shared store and one write was lost.";
  expect(() => parseLessons({ lessons: [{ scope: "role", rule: SHORT_RULE, why: "Writes raced." }] }, "builder")).toThrow(/letters or digits/);
  expect(() => parseLessons({ lessons: [{ scope: "role", rule: SYMBOLS, why }] }, "builder")).toThrow(/letters or digits/);
  expect(parseLessons({ lessons: [{ scope: "role", rule: SHORT_RULE, why }] }, "builder").lessons).toHaveLength(1);

  /* Records kept from before the minimum. */
  store([{ scope: "role", rule: SHORT_RULE, why: "Writes raced." }, { scope: "project", rule: SYMBOLS, why }]);
  expect(storedLessonTexts()).toEqual(expect.arrayContaining(["Writes raced.", SYMBOLS]));
  expect(withoutStoredLessons("Why: Writes raced.")).toBe(`Why: ${WITHHELD_LESSON_TEXT}.`);
  expect(withoutStoredLessons(`Applied ${SYMBOLS}`)).toBe(`Applied ${WITHHELD_LESSON_TEXT}`);
  const task = { id: "task-2", project: PROJECT, text: "Fix the store", details: `Why: writes  raced.\nRule: ${SYMBOLS}`, status: "inbox" } as unknown as BoardTask;
  expect(outboundTask(task).details).toBe(`Why: ${WITHHELD_LESSON_TEXT}.\nRule: ${WITHHELD_LESSON_TEXT}`);
  const deny = { ...EMPTY_DENY_LIST, lessons: storedLessonTexts() };
  const { dropped } = renderReport({ class: "status", name: "Delegatus", at: new Date("2026-10-07T12:00:00Z"), locale: "en", timeZone: "Europe/Kyiv",
    summary: "Store fixed.", sections: { inProgress: ["Why: Writes raced.", `Rule ${SYMBOLS}`, "the parser fix"] }, deny });
  expect(dropped.lesson).toBe(2);

  const repository = path.join(sandbox, "short-repository");
  fs.mkdirSync(repository);
  fs.writeFileSync(path.join(repository, "short.md"), "Why: Writes raced.\n");
  fs.writeFileSync(path.join(repository, "symbols.md"), `Rule: ${SYMBOLS}\n`);
  fs.writeFileSync(path.join(repository, "clean.md"), "The parser returns null for empty input.\n");
  const env = lessonPublicationEnv();
  for (const file of ["short.md", "symbols.md"]) expect(gateAt(repository, ["--paths", file], env).stdout).toContain("known_value: 1");
  expect(gateAt(repository, ["--paths", "clean.md"], env).status).toBe(0);
}, 60_000);

test("an agent's own push is refused when it carries a stored lesson in a file or a commit, a lesson learned after the agent started included", () => {
  /* The environment a structured host hands the agent at launch. */
  const launched = withAgentConfigSandbox({} as NodeJS.ProcessEnv, process.env);
  expect(launched.LLV_PRIVACY_KNOWN_VALUES_FILE).toBe(path.join(process.env.LLV_STATE_DIR!, "role-memory", "known-values.txt"));
  const LATER = "When a migration renames a column, keep a read of the old name until every writer has moved.";
  const repository = path.join(sandbox, "agent-repository");
  fs.mkdirSync(repository);
  const git = (...args: string[]) => {
    /* Only what git needs: no guard or identity this test process inherited. */
    const result = spawnSync("git", args, { cwd: repository, encoding: "utf8", env: { NODE_ENV: "test", PATH: process.env.PATH, HOME: sandbox, GIT_CONFIG_NOSYSTEM: "1",
      GIT_AUTHOR_NAME: "Fixture", GIT_AUTHOR_EMAIL: "noreply@example.invalid", GIT_COMMITTER_NAME: "Fixture", GIT_COMMITTER_EMAIL: "noreply@example.invalid" } });
    if (result.status !== 0) throw new Error(result.stderr);
    return result.stdout.trim();
  };
  git("init", "--initial-branch=main");
  git("config", "commit.gpgSign", "false");
  fs.writeFileSync(path.join(repository, "base.md"), "Base.\n");
  git("add", "-A"); git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  fs.writeFileSync(path.join(repository, "notes.md"), `Notes: ${LATER}\n`);
  git("add", "-A"); git("commit", "-m", "Notes");
  fs.writeFileSync(path.join(repository, "plain.md"), "Plain.\n");
  git("add", "-A"); git("commit", "-m", `Apply ${LATER.toLowerCase()}`);
  /* The pre-push privacy step as scripts/local-gate.ts runs it, with the committed fingerprints. */
  const prePush = (paths: string[]) => gateAt(repository, ["--base", base, "--require-known-values", "--check-commits", "--paths", ...paths], {
    LLV_PRIVACY_KNOWN_VALUES_FILE: launched.LLV_PRIVACY_KNOWN_VALUES_FILE,
    LLV_PRIVACY_KNOWN_VALUE_FINGERPRINTS_FILE: path.resolve(import.meta.dir, "../../../scripts/privacy-known-value-fingerprints.json"),
  });
  const before = prePush(["notes.md", "plain.md"]);
  expect(before.stdout).not.toContain("known_value");
  /* The lesson is learned while the agent runs. */
  store([{ scope: "machine", rule: LATER, why: "A rename broke a reader that still used the old column name." }]);
  const fileRefused = prePush(["notes.md"]);
  expect(fileRefused.status).toBe(1);
  expect(fileRefused.stdout).toContain("known_value");
  const commitRefused = prePush(["plain.md"]);
  expect(commitRefused.status).toBe(1);
  expect(commitRefused.stdout).toContain("known_value");
  expect(`${fileRefused.stdout}${commitRefused.stdout}`.toLowerCase()).not.toContain("every writer has moved");
}, 90_000);
