import type { Pipeline } from "@/lib/pipelines/types";

/*
 * One lane per graph shape the Stages window draws (redesign S2,
 * docs/design/redesign-2026-11/s2-build-brief.md §4): an optional fix on a
 * review's fail edge taken and not taken, a return loop, a visual critic with
 * its fix, a fix two reviewers share, a fix that returns to review, the
 * prototype lane, a terminal re-check, a skipped stage, a parked publication and
 * a parked question, a single stage, an eight-stage lane and a fix chain. Stage
 * ids and titles are invented; no lane of a live installation is copied. The
 * board's and the phone's evidence fixtures both read this one list, so the two
 * drivers frame the same lanes.
 */

export interface ShapeDeps {
  project: string;
  /** An ISO time this many seconds ago. */
  iso: (secondsAgo: number) => string;
  /** The text in the page's language. */
  L: (en: string, uk: string) => string;
  /** A conversation for one attempt: `working` while its agent is at work, `asking` while it waits on an answer, `settled` once its turn ended. */
  file: (id: string, title: string, state: "working" | "asking" | "settled") => { path: string; conversationId: string } | null;
}

export interface ShapeLane {
  slug: string;
  pipeline: Pipeline;
}

const MIN = 60;

const role = (roleId: string) => ({ roleId, engine: "claude", model: "opus", effort: "high", access: "read-write", promptScaffold: null });
const stage = (id: string, roleId: string, next: string | null, over: Record<string, unknown> = {}) =>
  ({ id, kind: roleId === "reviewer" ? "review-loop" : "run", role: { roleId }, prompt: `Stage ${id}.`, next, onFail: null, effectiveRole: role(roleId), ...over });
const fail = (to: string, maxRounds: number, onExhausted?: string) => ({ onFail: { to, maxRounds, ...(onExhausted ? { onExhausted } : {}) } });
const failVia = (stageId: string, attempt: number, extra: Record<string, unknown> = {}) => ({ activatedBy: { stageId, attempt, edge: "fail", ...extra } });
const passVia = (stageId: string, attempt: number, extra: Record<string, unknown> = {}) => ({ activatedBy: { stageId, attempt, edge: "pass", ...extra } });

/** The report a stage files when it stops to ask the operator: its summary is the question the pane shows. */
const stageQuestion = (summary: string) => ({
  seq: 1, at: new Date(0).toISOString(), actor: { kind: "agent" }, verdict: { status: "needs_decision", findings: [] }, summary,
  provenance: { state: "complete", outputs: [] }, calls: 1,
});

type Spec = Record<string, Array<[string, Record<string, unknown>?]>>;

export function buildStageShapes(deps: ShapeDeps): ShapeLane[] {
  const { project, iso, L } = deps;
  const lane = (slug: string, title: string, state: string, stages: unknown[], spec: Spec, cursorStage: string | null, over: Record<string, unknown> = {}): ShapeLane => {
    let count = 0;
    const runs = Object.entries(spec).map(([stageId, attempts]) => ({
      stageId,
      attempts: attempts.map(([attemptState, extra], index) => {
        count += 1;
        const live = attemptState === "running" || attemptState === "needs_decision";
        /* A stage that stopped for the operator's answer has no agent at work: its conversation waits on the question. */
        const conversation = attemptState === "running" ? "working" : attemptState === "needs_decision" && slug === "parked-question" ? "asking" : "settled";
        const file = attemptState === "skipped" ? null : deps.file(`${slug}-${stageId}-${index + 1}`, `${title}: ${stageId} ${index + 1}`, conversation);
        return {
          n: index + 1, state: attemptState, effectiveRole: role("builder"), launchId: file ? `launch-${slug}-${count}` : null, conversationId: file?.conversationId ?? null, sessionId: null,
          agentPath: file?.path ?? null, paneId: null, flowId: null, startedAt: iso((600 - count * 20) * MIN), completedAt: live ? null : iso((590 - count * 20) * MIN),
          input: null, activatedBy: null, output: null, verdict: attemptState === "needs_decision" ? { status: "needs_decision", findings: [] } : null, error: null, ...extra,
        };
      }),
    }));
    const pipeline = {
      id: `lane-shape-${slug}`, task: title, taskIds: [`t-shape-${slug}`], project, repoDir: "/repo", worktreeDir: `/repo-lane-shape-${slug}`, branch: `pipeline/lane-shape-${slug}`,
      baseBranch: "main", baseRef: "main", lastPassedCommit: "", stages, runs,
      cursor: cursorStage ? { stageId: cursorStage, state: state === "needs_decision" ? "needs_decision" : "running", input: null, activatedBy: null } : null,
      state, pausedState: null, stateDetail: null, srcPath: null, srcConversationId: null, createdAt: iso(8 * 60 * MIN), closedAt: state === "completed" ? iso(5 * MIN) : null, ...over,
    } as unknown as Pipeline;
    return { slug, pipeline };
  };
  const waitingChecks = { merge: { state: "waiting-checks", prNumber: 4821, requestedAt: iso(20 * MIN), updatedAt: iso(10 * MIN) } };
  return [
    lane("fix-skipped", L("Rename the export button", "Перейменувати кнопку експорту"), "completed",
      [stage("build", "builder", "review"), stage("review", "reviewer", null, fail("fix", 2)), stage("fix", "builder", "review")],
      { build: [["passed"]], review: [["passed", passVia("build", 1)]] }, null, waitingChecks),
    lane("fix-taken", L("Keep the filter after a reload", "Зберегти фільтр після перезавантаження"), "running",
      [stage("build", "builder", "review"), stage("review", "reviewer", null, fail("fix", 2)), stage("fix", "builder", "review")],
      { build: [["passed"]], review: [["failed", passVia("build", 1)]], fix: [["running", failVia("review", 1)]] }, "fix"),
    lane("return-loop", L("Retry the sync after a timeout", "Повторити синхронізацію після тайм-ауту"), "running",
      [stage("design", "architect", "build"), stage("build", "builder", "verify"), stage("verify", "verifier", "ship", fail("build", 2)), stage("ship", "cleaner", null)],
      { design: [["passed"]], build: [["passed", passVia("design", 1)], ["running", failVia("verify", 1)]], verify: [["failed", passVia("build", 1)]] }, "build"),
    lane("visual-gate", L("Show the account limits on the card", "Показати ліміти облікових записів на картці"), "running",
      [stage("brief", "architect", "build"), stage("build", "builder", "review"), stage("review", "reviewer", "visual", fail("fix", 2)), stage("fix", "builder", "review"),
        stage("visual", "visual-critic", null, fail("visual-fix", 1, "park")), stage("visual-fix", "builder", "visual")],
      { brief: [["passed"]], build: [["passed", passVia("brief", 1)]], review: [["failed", passVia("build", 1)], ["passed", passVia("fix", 1)]], fix: [["passed", failVia("review", 1)]],
        visual: [["failed", passVia("review", 2)]], "visual-fix": [["running", failVia("visual", 1)]] }, "visual-fix"),
    lane("shared-fix", L("Align the empty states", "Вирівняти порожні стани"), "running",
      [stage("brief", "architect", "build"), stage("fix", "builder", "review"), stage("build", "builder", "review"), stage("review", "reviewer", "visual", fail("fix", 2)), stage("visual", "visual-critic", null, fail("fix", 1, "park"))],
      { brief: [["passed"]], build: [["passed", passVia("brief", 1)]], review: [["passed", passVia("build", 1)]], visual: [["running", passVia("review", 1)]] }, "visual"),
    lane("returning-fix", L("Tighten the card spacing", "Підтягнути відступи картки"), "needs_decision",
      [stage("brief", "architect", "build"), stage("build", "builder", "review"), stage("review", "reviewer", "visual", fail("fix", 2)), stage("fix", "builder", "review"),
        stage("visual", "visual-critic", null, fail("visual-fix", 2, "park")), stage("visual-fix", "builder", "review")],
      { brief: [["passed"]], build: [["passed", passVia("brief", 1)]], review: [["passed", passVia("build", 1)]], visual: [["failed", passVia("review", 1)], ["needs_decision", passVia("review", 2)]],
        "visual-fix": [["passed", failVia("visual", 1)]] }, "visual", { stateDetail: "fail-edge budget exhausted: visual failed again" }),
    lane("prototype", L("Draft the settings window", "Накидати вікно налаштувань"), "completed",
      [stage("prototype", "builder", "critic"), stage("critic", "visual-critic", "publish", fail("proto-fix", 2)), stage("proto-fix", "builder", "critic"), stage("publish", "builder", null)],
      { prototype: [["passed"]], critic: [["failed", passVia("prototype", 1)], ["failed", passVia("proto-fix", 1)]],
        "proto-fix": [["passed", failVia("critic", 1)], ["passed", failVia("critic", 2, { budgetSpent: true })]], publish: [["passed", passVia("critic", 2)]] }, null),
    lane("recheck", L("Guard the upload retry", "Захистити повтор завантаження"), "completed",
      [stage("build", "builder", "review"), stage("review", "reviewer", null, fail("fix", 1)), stage("fix", "builder", "review")],
      { build: [["passed"]], review: [["failed", passVia("build", 1)], ["passed", passVia("fix", 1, { budgetRecheck: true })]], fix: [["passed", failVia("review", 1, { budgetSpent: true })]] }, null, waitingChecks),
    lane("skipped", L("Ship the changelog entry", "Випустити запис у журналі змін"), "completed",
      [stage("build", "builder", "review"), stage("review", "reviewer", "deliver"), stage("deliver", "cleaner", null)],
      { build: [["passed"]], review: [["passed", passVia("build", 1)]], deliver: [["skipped", passVia("review", 1)]] }, null),
    lane("parked-publication", L("Fix the date picker offset", "Виправити зсув вибору дати"), "needs_decision",
      [stage("fix", "builder", null)], { fix: [["passed"]] }, "fix", { stateDetail: "publishing the passed stage failed: the push was refused" }),
    lane("parked-question", L("Pick the export format", "Обрати формат експорту"), "needs_decision",
      [stage("design", "architect", "build"), stage("build", "builder", "review"), stage("review", "reviewer", null)],
      { design: [["passed"]], build: [["needs_decision", { ...passVia("design", 1), report: stageQuestion(L("Should the report keep the header row when it is exported as CSV?", "Чи лишати рядок заголовків у звіті, коли його експортують у CSV?")) }]] }, "build"),
    lane("single", L("Integrate the cache warm-up", "Інтегрувати прогрів кешу"), "running",
      [stage("integrate", "builder", null)], { integrate: [["failed"], ["running"]] }, "integrate"),
    lane("eight", L("Rebuild the import pipeline", "Перебудувати конвеєр імпорту"), "running",
      [stage("build", "builder", "amend"), stage("amend", "builder", "review"), stage("review", "reviewer", "integrate", fail("slice-fix", 2)), stage("integrate", "builder", "slice-critic"),
        stage("slice-critic", "reviewer", "publish", fail("slice-fix", 2, "park")), stage("slice-fix", "builder", "slice-critic"), stage("publish", "cleaner", null), stage("rate-fix", "builder", null)],
      { build: [["passed"]], amend: [["passed", passVia("build", 1)]], review: [["passed", passVia("amend", 1)]], integrate: [["passed", passVia("review", 1)]], "slice-critic": [["running", passVia("integrate", 1)]] }, "slice-critic"),
    lane("chain", L("Split the API and web fixes", "Розділити виправлення API та вебу"), "running",
      [stage("build", "builder", "review"), stage("review", "reviewer", "visual", fail("fix-api", 2)), stage("fix-api", "builder", "fix-web"), stage("fix-web", "builder", "review"), stage("visual", "visual-critic", null, fail("fix-web", 1))],
      { build: [["passed"]], review: [["failed", passVia("build", 1)]], "fix-api": [["running", failVia("review", 1)]] }, "fix-api"),
  ];
}
