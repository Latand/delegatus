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

const { leaveLessons, lessonPublicationEnv, projectView, recordLessonRequest, storedLessonTexts, withoutStoredLessons } = await import("./roleStore");
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
