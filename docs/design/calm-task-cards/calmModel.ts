/*
 * The calm card's model (docs/design/calm-task-cards.md §5): who owns what a
 * lane waits on, the one line the collapsed card says, why it stopped, what
 * the orchestrator does about it, and the task's chronology, all read from the
 * real records the board already carries. Pure: no DOM, no React.
 */
import type { Locale, TFunction } from "@/lib/i18n";
import type { KanbanCard } from "@/components/kanban/kanbanModel";
import { answerLabel, pipelineAnswers, type PipelineAnswers } from "@/components/pipelines/pipelineBlockModel";
import { stageDisplayName } from "@/components/pipelines/pipelineModel";
import type { Pipeline, PipelineStage, PipelineStageAttempt } from "@/lib/pipelines/types";
import type { PullRequestState } from "@/lib/forge/workLinks";

/** Who acts next: nobody (a stage runs), the system (a queue or a timer), the
    orchestrator seat, or the operator. `done` asks nothing. */
export type Owner = "working" | "waiting" | "seat" | "you" | "done";

export type Cause =
  | "running" | "done" | "paused"
  | "commit-deps" | "commit-load" | "commit-readonly" | "commit-other" | "publish"
  | "transport" | "auth" | "review-budget" | "review-stop"
  | "question" | "question-you"
  | "merge-conflict" | "merge-refreshing" | "merge-closed" | "merge-no-pr" | "merge-checks" | "merge-other";

const OWNER_RANK: Record<Owner, number> = { you: 0, seat: 1, waiting: 2, working: 3, done: 4 };

export interface LaneFacts {
  /** The lane's PR as the board resolved it, when it has one. */
  pr: { number: number; state: PullRequestState | null } | null;
  /** The seat escalated this lane's question to the operator in a decision
      form, under this short title. */
  escalated: string | null;
}

export interface CalmLane {
  pipeline: Pipeline;
  cause: Cause;
  owner: Owner;
  stage: PipelineStage | null;
  stageName: string;
  /** When the lane last moved, ms. */
  since: number;
  answers: PipelineAnswers | null;
  pr: LaneFacts["pr"];
  /** The raw words the record holds about the stop, for «Details». */
  detail: string | null;
  /** The decision form's short title, when the seat escalated it. */
  ask: string | null;
}

const latestAttempt = (pipeline: Pipeline, stageId: string): PipelineStageAttempt | null =>
  pipeline.runs.find((run) => run.stageId === stageId)?.attempts.at(-1) ?? null;

const at = (value: string | null | undefined): number => {
  const ms = Date.parse(value ?? "");
  return Number.isFinite(ms) ? ms : 0;
};

function laneSince(pipeline: Pipeline): number {
  const times = pipeline.runs.flatMap((run) => run.attempts.flatMap((attempt) => [at(attempt.startedAt), at(attempt.completedAt), at(attempt.report?.at)]));
  for (const entry of pipeline.stageReports ?? []) times.push(at(entry.at));
  const merge = pipeline.merge;
  if (merge) times.push(at(merge.blockedAt), at(merge.requestedAt), at(merge.mergedAt));
  return Math.max(at(pipeline.createdAt), ...times);
}

export function laneCause(pipeline: Pipeline, siblings: readonly Pipeline[]): Cause {
  const merge = pipeline.merge;
  if (pipeline.state === "completed" && merge?.state === "blocked" && !(at(pipeline.dismissedAt) >= at(merge.blockedAt ?? merge.updatedAt))) {
    const reason = merge.reason ?? "";
    if (/conflict/.test(reason)) return siblings.some((other) => other.id !== pipeline.id && ["running", "provisioning"].includes(other.state)) ? "merge-refreshing" : "merge-conflict";
    if (/was closed/.test(reason)) return "merge-closed";
    if (/no pull request/.test(reason)) return "merge-no-pr";
    if (/did not finish|check/.test(reason)) return "merge-checks";
    return "merge-other";
  }
  if (pipeline.state === "completed" || pipeline.state === "closed") return "done";
  if (pipeline.state === "paused") return "paused";
  if (pipeline.state === "needs_review") return "review-stop";
  if (pipeline.state !== "needs_decision") return "running";
  const stageId = pipeline.cursor?.stageId ?? "";
  const detail = `${pipeline.stateDetail ?? ""} ${latestAttempt(pipeline, stageId)?.error ?? ""}`;
  if (/stage verdict: needs_decision/.test(detail)) return "question";
  if (/read-only stage .* created a commit/.test(detail)) return "commit-readonly";
  if (/committing the passed stage/.test(detail)) return /Cannot find module/.test(detail) ? "commit-deps" : /timed out|CPU pressure/.test(detail) ? "commit-load" : "commit-other";
  if (/publishing the passed stage|pre-push/.test(detail)) return "publish";
  if (/authentication/.test(detail)) return "auth";
  if (/fail-edge budget/.test(detail)) return "review-budget";
  return "transport";
}

export function causeOwner(cause: Cause, facts: LaneFacts): Owner {
  if (cause === "running" || cause === "merge-refreshing") return "working";
  if (cause === "done") return "done";
  if (cause === "paused" || cause === "merge-checks") return "waiting";
  if (cause === "question") return facts.escalated !== null ? "you" : "seat";
  return "seat";
}

export function calmLane(t: TFunction, pipeline: Pipeline, siblings: readonly Pipeline[], facts: LaneFacts): CalmLane {
  const raw = laneCause(pipeline, siblings);
  const cause: Cause = raw === "question" && facts.escalated !== null ? "question-you" : raw;
  const stageId = pipeline.cursor?.stageId ?? null;
  const stage = stageId ? pipeline.stages.find((entry) => entry.id === stageId) ?? null : null;
  const nameOf = (entry: PipelineStage) => stageDisplayName(t, entry);
  const attempt = stage ? latestAttempt(pipeline, stage.id) : null;
  const detail = cause.startsWith("merge") ? pipeline.merge?.reason ?? null : attempt?.error ?? pipeline.stateDetail ?? null;
  return {
    pipeline, cause, owner: causeOwner(raw, facts), stage, stageName: stage ? nameOf(stage) : "",
    since: laneSince(pipeline), answers: pipelineAnswers(pipeline, nameOf), pr: facts.pr, detail: detail ? tidyDetail(detail) : null,
    ask: facts.escalated,
  };
}

/* A file path, with or without a line number: nothing the operator reads. */
const PATH = /(?:\$HOME|~\/|\b(?:scripts|src|docs|bin)\/)\S*|\b[\w./-]+\.\w+:\d+/;

/** The record's own words about a stop, as «Details» shows them: whole lines
    and whole sentences only. The extract cuts long agent texts, so a sentence
    that ends in the cut is dropped, and so is one that names a file; the full
    record stays one tap away in the stage's conversation. */
export function tidyDetail(raw: string): string {
  const lines = raw.split(" · Viewer publication")[0]!.split("\n").map((line) =>
    line.split(/(?<=[.!?])\s+/).filter((sentence) => !sentence.trimEnd().endsWith("…") && !PATH.test(sentence)).join(" ").trim());
  return lines.filter((line) => line && !/^Require stack:/.test(line)).join("\n");
}

/** The lanes a card speaks about, the one that matters first. */
export function cardLanes(t: TFunction, card: KanbanCard, facts: (pipeline: Pipeline) => LaneFacts): CalmLane[] {
  const pipelines = card.pipelines.map((summary) => summary.pipeline);
  return pipelines
    .map((pipeline) => calmLane(t, pipeline, pipelines, facts(pipeline)))
    .sort((a, b) => OWNER_RANK[a.owner] - OWNER_RANK[b.owner] || causeRank(a) - causeRank(b) || b.since - a.since);
}

/* Among lanes of one owner, the one with something to say comes first: a
   merge being refreshed before the refresh lane's own running stage. */
const causeRank = (lane: CalmLane) => (lane.cause === "running" ? 1 : 0);

export function cardOwner(lanes: readonly CalmLane[], status: string): Owner {
  return lanes[0]?.owner ?? (status === "done" ? "done" : "waiting");
}

/* ── Words ─────────────────────────────────────────────────────────────── */

type Copy = Record<string, string>;
const UK: Copy = {
  "owner.working": "Працює",
  "owner.waiting": "Чекає черги",
  "owner.seat": "Оркестратор розбирається",
  "owner.you": "Потрібна ваша відповідь",
  "owner.done": "Готово",
  "pop.working": "Працює вже {age}",
  "pop.waiting": "Чекає в черзі вже {age}",
  "pop.seat": "Оркестратор розбирається вже {age}",
  "pop.you": "Чекає вашої відповіді вже {age}",
  "pop.done": "Готово {age} тому",
  "line.running": "{stage} працює",
  "line.done": "Готово",
  "line.paused": "На паузі",
  "line.commit-deps": "Оркестратор повторює коміт «{stage}»",
  "line.commit-load": "Оркестратор повторить коміт «{stage}», коли спаде навантаження",
  "line.commit-readonly": "Оркестратор перезапускає «{stage}» без зайвого коміту",
  "line.commit-other": "Оркестратор повторює коміт «{stage}»",
  "line.publish": "Оркестратор повторює публікацію гілки",
  "line.transport": "Оркестратор перезапускає «{stage}»",
  "line.transport-merged": "PR #{pr} уже змерджено — оркестратор закриває лінію",
  "line.auth": "Оркестратор переводить «{stage}» на інший акаунт",
  "line.review-budget": "Оркестратор вирішує, чи приймати без ще одного рев'ю",
  "line.review-stop": "Оркестратор вирішує, чи приймати без ще одного рев'ю",
  "line.question": "Оркестратор відповідає на питання етапу «{stage}»",
  "line.question-you": "Потрібна ваша відповідь: {ask}",
  "line.merge-conflict": "Оркестратор оновлює PR #{pr} з main",
  "line.merge-refreshing": "PR #{pr} оновлюється з main перед мерджем",
  "line.merge-closed": "PR #{pr} закрито — зміни вже в main",
  "line.merge-no-pr": "Нічого мерджити: лінія без PR",
  "line.merge-checks": "Мердж PR #{pr} чекає перевірок",
  "line.merge-other": "Оркестратор розбирається з мерджем PR #{pr}",
  "why.commit-deps": "Етап «{stage}» пройшов, але коміт його роботи не вдався: у робочій копії немає залежностей, і перевірка eslint не запустилась.",
  "why.commit-load": "Етап «{stage}» пройшов, але перевірки коміту не вклались у 60 с: машина була перевантажена.",
  "why.commit-readonly": "Етап «{stage}» мав лише читати, але сам створив коміт. Такий коміт у гілку не приймається.",
  "why.commit-other": "Етап «{stage}» пройшов, але коміт його роботи не вдався.",
  "why.publish": "Гілку не вдалося опублікувати: перевірки перед пушем не вклались у свій час.",
  "why.transport": "Зв'язок з агентом етапу «{stage}» обірвався, і автоматичне відновлення не вдалося за 10 хв.",
  "why.auth": "Акаунт етапу «{stage}» не пройшов перевірку входу.",
  "why.review-budget": "Рев'ю знову знайшло зауваження, а раунди рев'ю закінчились.",
  "why.review-stop": "Останнє виправлення ніхто не переглянув: раунди рев'ю закінчились.",
  "why.question": "Етап «{stage}» поставив питання.",
  "why.question-you": "Діагностиці потрібен вивід однієї read-only команди з вашої другої установки. Агенти туди не мають доступу.",
  "why.merge-conflict": "Автомердж зупинився: PR #{pr} конфліктує з main.",
  "why.merge-refreshing": "Автомердж зупинився: PR #{pr} конфліктує з main.",
  "why.merge-closed": "Автомердж зупинився: PR #{pr} закрито.",
  "why.merge-no-pr": "Автомердж зупинився: у лінії немає PR.",
  "why.merge-checks": "Автомердж зупинився: перевірки не завершились за 90 хв.",
  "why.merge-other": "Автомердж зупинився.",
  "seat.commit-deps": "Встановлює залежності (bun install --frozen-lockfile) і повторює коміт. Робота етапу збережена, заново нічого не запускається.",
  "seat.commit-load": "Повторює коміт, щойно навантаження спаде. Робота етапу збережена.",
  "seat.commit-readonly": "Перезапускає етап із останнього пройденого коміту; зайвий коміт у гілку не потрапить.",
  "seat.commit-other": "Читає помилку, виправляє середовище й повторює коміт.",
  "seat.publish": "Зливає свіжий main і повторює пуш.",
  "seat.transport": "Запускає етап наново з тим самим входом.",
  "seat.transport-merged": "PR #{pr} уже в main, повтор рев'ю нічого не дасть. Закриває лінію і позначає задачу виконаною.",
  "seat.auth": "Переводить етап на акаунт, що пройшов вхід. Якщо таких немає, попросить вас увійти.",
  "seat.review-budget": "Звіряє зауваження з правилом проєкту: N раундів, виправити останнє, мерджити.",
  "seat.review-stop": "Звіряє зауваження з правилом проєкту: N раундів, виправити останнє, мерджити.",
  "seat.question": "Відповідає на питання сам: рекомендація етапу або правило проєкту.",
  "seat.question-you": "Сам відповісти не може: ці дані є лише у вас. Щойно ви надішлете вивід, діагностика продовжиться.",
  "seat.merge-conflict": "Запускає лінію оновлення: злити main, розв'язати конфлікт, одне рев'ю, мердж.",
  "seat.merge-refreshing": "Уже запустив лінію оновлення: вона зливає main і розв'язує конфлікт.",
  "seat.merge-closed": "Зміни прийшли в main іншим PR. Знімає це чекання, робити нічого.",
  "seat.merge-no-pr": "Лінія лише писала документ. Знімає чекання мерджу.",
  "seat.merge-checks": "Повторює мердж, коли перевірки стануть зеленими.",
  "seat.merge-other": "Читає відповідь GitHub і повторює мердж.",
  "section.why": "Чому зупинилось",
  "section.seat": "Що робить оркестратор",
  "section.self": "Якщо хочете самі",
  "section.next": "Далі",
  "section.history": "Хронологія",
  "details": "Подробиці",
  "details.full": "Повний запис — у розмові етапу",
  "answer": "Відповісти",
  "ask": "Запитати оркестратора",
  "now": "зараз",
  "history.count": "Хронологія · {n}",
  "lanes.more": "+{n} лінія",
  "menu.card": "Меню картки",
  "summary.stopped": "Зупинилось",
  "summary.seat": "Оркестратор",
  "summary.next": "Далі",
  "summary.self": "Самі",
  "next.seat": "Звіт прийде в розмову оркестратора",
  "next.you": "Після вашої відповіді лінія продовжиться сама",
  "next.working": "Після рев'ю мердж піде сам",
  "ev.created": "Задачу створено",
  "ev.started": "{stage}: почалось",
  "ev.passed": "{stage}: пройдено",
  "ev.failed": "{stage}: {n} зауважень",
  "ev.failed1": "{stage}: 1 зауваження",
  "ev.failedFew": "{stage}: {n} зауваження",
  "ev.restart": "{stage}: перервав перезапуск Delegatus, запущено заново",
  "ev.restartN": "{stage}: {n} рази перервав перезапуск Delegatus",
  "ev.hostLost": "{stage}: загубився агент, запущено заново",
  "ev.stopped": "{stage}: зупинилось — {why}",
  "ev.running": "{stage}: працює",
  "ev.mergeQueued": "Мердж PR #{pr} у черзі",
  "ev.mergeStopped": "Мердж зупинено: {why}",
  "ev.merged": "PR #{pr} змерджено",
  "ev.seat": "Оркестратор: {text}",
  "ev.lane": "Запущено лінію: {chain}",
  "ev.earlier": "Раніше · {n}",
  "short.db": "база Delegatus була зайнята",
  "short.cancelled": "зупинено вручну",
  "short.verdict": "етап поставив питання",
  "ev.you": "Чекає вашої відповіді",
  "short.commit-deps": "коміт без залежностей",
  "short.commit-load": "коміт не вклався в 60 с",
  "short.commit-readonly": "етап для читання створив коміт",
  "short.commit-other": "коміт не вдався",
  "short.transport": "обірвався зв'язок з агентом",
  "short.question": "питання до вас",
  "short.conflict": "конфлікт з main",
  "short.closed": "PR закрито",
  "short.other": "див. подробиці",
};
const EN: Copy = {
  "owner.working": "Working",
  "owner.waiting": "Waiting in a queue",
  "owner.seat": "The orchestrator is on it",
  "owner.you": "Needs your answer",
  "owner.done": "Done",
  "pop.working": "Working for {age}",
  "pop.waiting": "Waiting in a queue for {age}",
  "pop.seat": "The orchestrator has been on it for {age}",
  "pop.you": "Waiting for your answer for {age}",
  "pop.done": "Done {age} ago",
  "line.running": "{stage} is running",
  "line.done": "Done",
  "line.paused": "Paused",
  "line.commit-deps": "The orchestrator retries the {stage} commit",
  "line.commit-load": "The orchestrator retries the {stage} commit once the load drops",
  "line.commit-readonly": "The orchestrator reruns {stage} without its stray commit",
  "line.commit-other": "The orchestrator retries the {stage} commit",
  "line.publish": "The orchestrator retries publishing the branch",
  "line.transport": "The orchestrator restarts {stage}",
  "line.transport-merged": "PR #{pr} is already merged; the orchestrator closes the lane",
  "line.auth": "The orchestrator moves {stage} to another account",
  "line.review-budget": "The orchestrator decides whether to accept without another review",
  "line.review-stop": "The orchestrator decides whether to accept without another review",
  "line.question": "The orchestrator answers the {stage} question",
  "line.question-you": "Needs your answer: {ask}",
  "line.merge-conflict": "The orchestrator updates PR #{pr} from main",
  "line.merge-refreshing": "PR #{pr} is being updated from main before the merge",
  "line.merge-closed": "PR #{pr} was closed; the changes are already in main",
  "line.merge-no-pr": "Nothing to merge: the lane has no PR",
  "line.merge-checks": "The PR #{pr} merge waits for checks",
  "line.merge-other": "The orchestrator handles the PR #{pr} merge",
  "why.commit-deps": "{stage} passed, but committing its work failed: the worktree has no dependencies, so the eslint check could not start.",
  "why.commit-load": "{stage} passed, but the commit checks did not finish within 60 s: the machine was overloaded.",
  "why.commit-readonly": "{stage} was meant to only read, yet it made a commit. Such a commit is not accepted into the branch.",
  "why.commit-other": "{stage} passed, but committing its work failed.",
  "why.publish": "The branch could not be published: the pre-push checks ran out of time.",
  "why.transport": "The connection to the {stage} agent dropped, and automatic recovery failed within 10 min.",
  "why.auth": "The {stage} account failed its sign-in check.",
  "why.review-budget": "The review found issues again, and the review rounds ran out.",
  "why.review-stop": "Nobody reviewed the last fix: the review rounds ran out.",
  "why.question": "{stage} asked a question.",
  "why.question-you": "The diagnosis needs the output of one read-only command from your second installation. Agents have no access there.",
  "why.merge-conflict": "Auto-merge stopped: PR #{pr} conflicts with main.",
  "why.merge-refreshing": "Auto-merge stopped: PR #{pr} conflicts with main.",
  "why.merge-closed": "Auto-merge stopped: PR #{pr} was closed.",
  "why.merge-no-pr": "Auto-merge stopped: the lane has no PR.",
  "why.merge-checks": "Auto-merge stopped: checks did not finish within 90 min.",
  "why.merge-other": "Auto-merge stopped.",
  "seat.commit-deps": "Installs the dependencies (bun install --frozen-lockfile) and retries the commit. The stage's work is kept; nothing runs again.",
  "seat.commit-load": "Retries the commit as soon as the load drops. The stage's work is kept.",
  "seat.commit-readonly": "Reruns the stage from the last passed commit; the stray commit never reaches the branch.",
  "seat.commit-other": "Reads the error, fixes the environment and retries the commit.",
  "seat.publish": "Merges fresh main and retries the push.",
  "seat.transport": "Starts the stage again with the same input.",
  "seat.transport-merged": "PR #{pr} is already in main, so another review changes nothing. Closes the lane and marks the task done.",
  "seat.auth": "Moves the stage to an account that is signed in. If none is, it asks you to sign in.",
  "seat.review-budget": "Weighs the findings against the project rule: N rounds, fix the last, merge.",
  "seat.review-stop": "Weighs the findings against the project rule: N rounds, fix the last, merge.",
  "seat.question": "Answers the question itself: the stage's recommendation or a project rule.",
  "seat.question-you": "It cannot answer this itself: only you have that data. Once you send the output, the diagnosis goes on.",
  "seat.merge-conflict": "Starts an update lane: merge main, resolve the conflict, one review, merge.",
  "seat.merge-refreshing": "Already started an update lane: it merges main and resolves the conflict.",
  "seat.merge-closed": "The changes reached main through another PR. Clears this wait; nothing to do.",
  "seat.merge-no-pr": "The lane only wrote a document. Clears the merge wait.",
  "seat.merge-checks": "Retries the merge once the checks are green.",
  "seat.merge-other": "Reads GitHub's answer and retries the merge.",
  "section.why": "Why it stopped",
  "section.seat": "What the orchestrator does",
  "section.self": "If you want to act yourself",
  "section.next": "Next",
  "section.history": "Timeline",
  "details": "Details",
  "details.full": "Full record in the stage's conversation",
  "answer": "Answer",
  "ask": "Ask the orchestrator",
  "now": "now",
  "history.count": "Timeline · {n}",
  "lanes.more": "+{n} lane",
  "menu.card": "Card menu",
  "summary.stopped": "Stopped",
  "summary.seat": "Orchestrator",
  "summary.next": "Next",
  "summary.self": "Yourself",
  "next.seat": "The report arrives in the orchestrator's chat",
  "next.you": "Once you answer, the lane goes on by itself",
  "next.working": "After the review the merge goes on by itself",
  "ev.created": "Task created",
  "ev.started": "{stage} started",
  "ev.passed": "{stage} passed",
  "ev.failed": "{stage}: {n} findings",
  "ev.failed1": "{stage}: 1 finding",
  "ev.failedFew": "{stage}: {n} findings",
  "ev.restart": "{stage}: cut by a Delegatus restart, started again",
  "ev.restartN": "{stage}: cut {n} times by a Delegatus restart",
  "ev.hostLost": "{stage}: the agent was lost, started again",
  "ev.stopped": "{stage} stopped: {why}",
  "ev.running": "{stage} is running",
  "ev.mergeQueued": "PR #{pr} merge queued",
  "ev.mergeStopped": "Merge stopped: {why}",
  "ev.merged": "PR #{pr} merged",
  "ev.seat": "Orchestrator: {text}",
  "ev.lane": "Lane started: {chain}",
  "ev.earlier": "Earlier · {n}",
  "short.db": "the Delegatus database was busy",
  "short.cancelled": "stopped by hand",
  "short.verdict": "the stage asked a question",
  "ev.you": "Waiting for your answer",
  "short.commit-deps": "commit without dependencies",
  "short.commit-load": "commit took over 60 s",
  "short.commit-readonly": "a read-only stage made a commit",
  "short.commit-other": "commit failed",
  "short.transport": "lost the connection to the agent",
  "short.question": "a question for you",
  "short.conflict": "conflict with main",
  "short.closed": "PR closed",
  "short.other": "see details",
};

export function words(locale: Locale) {
  const copy = locale === "uk" ? UK : EN;
  return (key: string, params: Record<string, string | number> = {}): string =>
    (copy[key] ?? key).replace(/\{(\w+)\}/g, (_, name: string) => String(params[name] ?? ""));
}
export type Words = ReturnType<typeof words>;

/** The three words a cause speaks in: the collapsed line, why, and the seat. */
export function laneWords(w: Words, lane: CalmLane): { line: string; why: string | null; seat: string | null } {
  const params = { stage: lane.stageName, pr: lane.pr?.number ?? lane.pipeline.merge?.prNumber ?? "", ask: lane.ask ?? "" };
  const merged = lane.cause === "transport" && lane.pr?.state === "merged";
  const key = merged ? "transport-merged" : lane.cause;
  const quiet = lane.owner === "working" && lane.cause === "running";
  return {
    line: w(`line.${quiet ? "running" : key}`, params),
    why: lane.owner === "working" && lane.cause === "running" || lane.cause === "done" ? null : w(`why.${lane.cause}`, params),
    seat: lane.cause === "running" || lane.cause === "done" ? null : w(`seat.${key}`, params),
  };
}

/** The real answers a lane offers today, in today's words. */
export function laneActions(t: TFunction, lane: CalmLane): { action: string; label: string }[] {
  const answers = lane.answers;
  if (!answers) return [];
  return answers.choices.map((choice) => ({ action: choice.action, label: answerLabel(t, answers, choice, false) }));
}

/* ── Time ──────────────────────────────────────────────────────────────── */

const ZONE = "Europe/Kyiv";

/** A clock time in h23, with the day when it is not the snapshot's day. */
export function clock(locale: Locale, ms: number, nowMs: number): string {
  const day = (value: number) => new Intl.DateTimeFormat("en-CA", { timeZone: ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(value);
  const time = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "en-GB", { timeZone: ZONE, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(ms);
  if (day(ms) === day(nowMs)) return time;
  const date = new Intl.DateTimeFormat(locale === "uk" ? "uk-UA" : "en-GB", { timeZone: ZONE, day: "numeric", month: "short" }).format(ms);
  return `${date} ${time}`;
}

/* ── Chronology ────────────────────────────────────────────────────────── */

export type EventTone = "ok" | "bad" | "stop" | "live" | "seat" | "you" | "info";

export interface TimelineEvent {
  at: number;
  /** Null for an entry that is about now (the seat's handling). */
  time: string | null;
  tone: EventTone;
  text: string;
  /** The stop this lane is on: its actions ride on this entry. */
  stop?: CalmLane;
}

const restartCut = (attempt: PipelineStageAttempt) => /interrupted by a Delegatus restart/.test(attempt.error ?? "");
const hostLost = (attempt: PipelineStageAttempt) => /stage host was lost/.test(attempt.error ?? "");

function findingCount(attempt: PipelineStageAttempt): number {
  return attempt.verdict?.findings?.length ?? attempt.report?.verdict?.findings?.length ?? 0;
}

function failedText(w: Words, locale: Locale, stage: string, n: number): string {
  if (n === 1) return w("ev.failed1", { stage });
  if (locale === "uk" && n % 10 >= 2 && n % 10 <= 4 && (n % 100 < 12 || n % 100 > 14)) return w("ev.failedFew", { stage, n });
  return w("ev.failed", { stage, n });
}

/** An earlier stop's cause, from its own error. */
function attemptWhy(w: Words, attempt: PipelineStageAttempt): string {
  const error = attempt.error ?? "";
  if (/stage verdict: needs_decision/.test(error) || attempt.verdict?.status === "needs_decision") return w("short.verdict");
  if (/database is locked/.test(error)) return w("short.db");
  if (/cancelled by/.test(error)) return w("short.cancelled");
  if (/committing the passed stage|created a commit/.test(error)) return w("short.commit-other");
  if (/transport|runtime host|lost its host|spawn recovery/.test(error)) return w("short.transport");
  return w("short.other");
}

function shortWhy(w: Words, lane: CalmLane): string {
  switch (lane.cause) {
    case "commit-deps": case "commit-load": case "commit-readonly": case "commit-other": return w(`short.${lane.cause}`);
    case "transport": return w("short.transport");
    case "question": case "question-you": return w("short.question");
    default: return w("short.other");
  }
}

/** The task in order: created, every attempt's outcome (restarts folded),
    merges, and last what happens now. */
export function chronology(t: TFunction, locale: Locale, card: KanbanCard, lanes: readonly CalmLane[], nowMs: number): TimelineEvent[] {
  const w = words(locale);
  const events: TimelineEvent[] = [];
  const created = at(card.task?.createdAt);
  if (created) events.push({ at: created, time: null, tone: "info", text: w("ev.created") });
  for (const lane of lanes) {
    const pipeline = lane.pipeline;
    if (lanes.length > 1) {
      const chain = pipeline.stages.filter((stage) => !pipeline.stages.some((other) => other.onFail?.to === stage.id) || stage.next).slice(0, 4).map((stage) => stageDisplayName(t, stage)).join(" → ");
      events.push({ at: at(pipeline.createdAt), time: null, tone: "info", text: w("ev.lane", { chain }) });
    }
    const nameOf = (stageId: string) => {
      const stage = pipeline.stages.find((entry) => entry.id === stageId);
      return stage ? stageDisplayName(t, stage) : stageId;
    };
    for (const run of pipeline.runs) {
      const stage = nameOf(run.stageId);
      let cuts: PipelineStageAttempt[] = [];
      const flush = () => {
        if (!cuts.length) return;
        const last = cuts.at(-1)!;
        events.push({ at: at(last.completedAt) || at(last.startedAt), time: null, tone: "bad", text: cuts.length > 1 ? w("ev.restartN", { stage, n: cuts.length }) : w("ev.restart", { stage }) });
        cuts = [];
      };
      for (const attempt of run.attempts) {
        if (restartCut(attempt)) { cuts.push(attempt); continue; }
        flush();
        const started = at(attempt.startedAt);
        const ended = at(attempt.completedAt);
        if (attempt.state === "passed") events.push({ at: ended || started, time: null, tone: "ok", text: w("ev.passed", { stage }) });
        else if (attempt.state === "failed" && hostLost(attempt)) events.push({ at: ended || started, time: null, tone: "bad", text: w("ev.hostLost", { stage }) });
        else if (attempt.state === "failed") events.push({ at: ended || started, time: null, tone: "bad", text: failedText(w, locale, stage, findingCount(attempt)) });
        else if (attempt.state === "needs_decision") {
          const current = lane.stage?.id === run.stageId && attempt === run.attempts.at(-1) && pipeline.state === "needs_decision";
          if (current && started) events.push({ at: started, time: null, tone: "info", text: w("ev.started", { stage }) });
          events.push({ at: ended || at(attempt.report?.at) || started, time: null, tone: current ? "stop" : "bad", text: w("ev.stopped", { stage, why: current ? shortWhy(w, lane) : attemptWhy(w, attempt) }), ...(current ? { stop: lane } : {}) });
        } else if (["running", "reviewing", "committing", "spawning"].includes(attempt.state)) events.push({ at: started, time: null, tone: "live", text: w("ev.running", { stage }) });
      }
      flush();
    }
    const merge = pipeline.merge;
    if (merge) {
      const pr = merge.prNumber ?? "";
      if (merge.requestedAt) events.push({ at: at(merge.requestedAt), time: null, tone: "info", text: w("ev.mergeQueued", { pr }) });
      if (merge.state === "blocked" && merge.blockedAt) {
        const why = /conflict/.test(merge.reason ?? "") ? w("short.conflict") : /closed/.test(merge.reason ?? "") ? w("short.closed") : w("short.other");
        events.push({ at: at(merge.blockedAt), time: null, tone: lane.owner === "done" ? "bad" : "stop", text: w("ev.mergeStopped", { why }), ...(lane.cause.startsWith("merge") ? { stop: lane } : {}) });
      }
      if (merge.state === "merged" && merge.mergedAt) events.push({ at: at(merge.mergedAt), time: null, tone: "ok", text: w("ev.merged", { pr }) });
    }
  }
  events.sort((a, b) => a.at - b.at);
  for (const event of events) event.time = clock(locale, event.at, nowMs);
  const top = lanes[0];
  if (top && (top.owner === "seat" || top.owner === "you")) {
    const said = laneWords(w, top);
    events.push(top.owner === "you"
      ? { at: nowMs, time: null, tone: "you", text: w("ev.you") }
      : { at: nowMs, time: null, tone: "seat", text: w("ev.seat", { text: said.seat ?? "" }) });
  }
  return events;
}
