/*
 * The calm-task-cards prototype page (docs/design/calm-task-cards.md §6),
 * bundled and served by the kanban harness (`serveEvidenceFixture`) and
 * driven by `render.ts`. It draws the board's real cards from `cards.json`, a
 * read-only, anonymised extract of the production board at its snapshot, as
 * they render today («original»: `KanbanCard` on the desktop, `MobileKanban`
 * and `MobileTaskScreen` on the phone) or as one of the three variants.
 *
 *   ?frame=board|open&variant=0..3&w=1440|390
 */
import { createRoot } from "react-dom/client";
import type { ReactNode } from "react";

import { translate, useLocale, type Locale, type TFunction } from "@/lib/i18n";
import type { Pipeline } from "@/lib/pipelines/types";
import type { BoardTask, TaskStatus } from "@/lib/tasks/types";
import type { FilesWorkLinks, PullRequestState, WorkLink } from "@/lib/forge/workLinks";
import type { SchemeLayout } from "@/components/scheme/layout";
import { buildTaskBands } from "@/components/scheme/taskBands";
import { projectTaskWorkflows } from "@/components/tasks/taskWorkflowModel";
import { buildKanbanModel, type KanbanCard as KanbanCardModel } from "@/components/kanban/kanbanModel";
import { KanbanCard, type KanbanCardProps } from "@/components/kanban/KanbanCard";
import { MobileKanban } from "@/components/mobile/MobileKanban";
import { MobileTaskScreen } from "@/components/mobile/MobileTaskScreen";
import { WorkLinksProvider } from "@/components/workLinks/workLinksContext";
import { writePlace } from "@/components/mobile/phoneKanbanPlace";

import data from "./cards.json";
import { cardLanes, chronology, type LaneFacts } from "./calmModel";
import { CalmCard, type Variant } from "./CalmCards";

const params = new URLSearchParams(location.search);
const FRAME = params.get("frame") === "open" ? "open" : "board";
const VARIANT = Number(params.get("variant") ?? 0) as 0 | Variant;
/* The width the driver set: under phone emulation the layout viewport grows
   with overflowing content, so the page never reads it back. */
const WIDTH = Number(params.get("w") ?? 1440);
const PHONE = WIDTH < 700;
const LOCALE: Locale = localStorage.getItem("llv_lang") === "uk" ? "uk" : "en";
const NOW_MS = Date.parse(data.snapshot);
const NOW_S = Math.floor(NOW_MS / 1000);
const PROJECT = "delegatus";

/* The stored task texts are Ukrainian, as on the operator's board; the en
   frames carry a faithful translation so they read in one language. */
const EN_TEXT: Record<string, string> = {
  "t-automerge-checks": "Auto-merge waits only for the required checks\nThe fix for #2723 was delivered through #2738 and deployed in version …; auto-merge counts the required checks.",
  "t-node-modules": "A stage with no node_modules commits its files\nThe fix passed review and is published on the lane's branch. There is no PR yet; publishing to main and the deploy are still open.",
  "t-unsafe-root": "«Ask in parallel» fails with unsafe-root\nOn the operator's second installation, «Ask in parallel» on a busy orchestrator answers «the seat's transcript could not be forked: unsafe-root». Asking in parallel must work, and an error, if one still happens, must make sense to a person.",
  "t-midturn-review": "Messages sent during an agent's turn show in the conversation\nMessages from voice, the operator or other agents that arrive while an agent works do not show in the history today, although the agent receives them. They must appear in the conversation, marked with their sender.",
  "t-activity-truth": "It is visible when an agent really stands still and when it works\nThe activity tool shows agents «stalled for 4.8 h» although they just did something, so neither the orchestrator nor the operator sees who really stands still. Each agent needs one simple honest marker: working, waiting on a check, or idle for N minutes, and the orchestrator must get a signal when an agent really stands still.",
  "t-reject-redo": "Prototypes: «Reject all» with corrections, and a critic before showing\nThe prototype form has no way to reject every variant; you have to pick something. It needs a «Reject and redo» button where corrections can be dictated or typed and which plainly opens a new round, and every prototype must pass a visual critic over all variants, with fixes, before the operator sees it.",
  "t-voice-head": "Voice Delegatus on the phone: a floating head, as on the computer\nOn the phone the voice orchestrator does not appear today. It needs the same floating head with flying words as on the desktop: always on screen, staying through moves between projects, orchestrators and agents while the conversation goes on, and it can be hidden completely and brought back from the menu.",
};

const tasks: BoardTask[] = (data.tasks as unknown as BoardTask[]).map((task) => ({
  ...task,
  text: LOCALE === "en" ? EN_TEXT[task.id] ?? task.text : task.text.replaceAll("<id>", "…"),
}));
const pipelines = data.pipelines as unknown as Pipeline[];

/* The PRs the board resolved for these lanes at the snapshot. */
const PRS: Record<string, { number: number; state: PullRequestState }> = {
  "node-modules": { number: 2780, state: "open" },
  "node-modules-refresh": { number: 2780, state: "open" },
  "midturn-review": { number: 2749, state: "merged" },
  "midturn-review-earlier-10": { number: 2749, state: "merged" },
  "automerge-checks": { number: 2723, state: "closed" },
};
/* The one question the seat could not answer and asked the operator in a
   decision form, under the form's short title. */
const ESCALATED: Record<string, Record<Locale, string>> = {
  "unsafe-root": { uk: "вивід команди з другої установки", en: "a command's output from your second installation" },
};
const link = (number: number, state: PullRequestState): WorkLink => ({
  key: `owner/delegatus#${number}`, kind: "pr", repository: "owner/delegatus", number, url: `https://forge.example/owner/delegatus/pull/${number}`,
  source: "auto", via: ["delivery-pr"], state, checkedAt: data.snapshot,
});
const workLinks: FilesWorkLinks = {
  pipelines: Object.fromEntries(pipelines.map((pipeline) => {
    const pr = PRS[pipeline.id];
    return [pipeline.id, { links: pr ? [link(pr.number, pr.state)] : [], repository: "owner/delegatus", noPr: !pr }];
  })),
  tasks: {},
};
const facts = (pipeline: Pipeline): LaneFacts => ({ pr: PRS[pipeline.id] ?? null, escalated: ESCALATED[pipeline.id]?.[LOCALE] ?? null });

const emptyLayout = { nodes: [], groups: [], stacks: [], decks: [], drafts: [], slots: [], regionTasks: [], edges: [], links: [], loops: [], byPath: new Map(), width: 0, height: 0 } as unknown as SchemeLayout;
const projection = projectTaskWorkflows(tasks, pipelines, [], [], PROJECT);
const bands = buildTaskBands(emptyLayout, { tasks, projection, untitled: translate(LOCALE, "kanban.untitled"), deferDoneVisibility: true });
const model = buildKanbanModel({ bands, tasks, pipelines, projection, files: [], now: NOW_S });
const COLUMNS: TaskStatus[] = ["assigned", "blocked", "done"];
const cardOf = (taskId: string): KanbanCardModel => COLUMNS.flatMap((status) => model.columns[status].cards).find((card) => card.task?.id === taskId)!;
const OPENED = ["t-voice-head", "t-unsafe-root", "t-node-modules", "t-midturn-review"];

const noop = () => undefined;
const translateT: TFunction = (key, values) => translate(LOCALE, key, values);
const originalProps = (card: KanbanCardModel): KanbanCardProps => ({
  card, status: card.status, pending: false, collapsed: false, nowMs: NOW_MS,
  onToggleCollapsed: noop, onCardMenu: noop, onKey: noop, onPointerDown: noop, onOpenMember: noop, onOpenStage: noop, onFocusCard: noop, onOpenConversations: noop,
  editing: null, failedEdit: null, incomingEdit: null, onStartEdit: noop, onEditDraft: noop, onCommitEdit: noop, onCancelEdit: noop, onRetryEdit: noop, onDiscardEdit: noop,
  onUseTheirs: noop, onKeepMine: noop, onHide: noop, graphChoices: new Map(), onToggleGraph: noop, onOpenAttempt: noop, readerKeys: "", stagePanels: "", acting: "",
  drafts: {} as KanbanCardProps["drafts"], pipelinePorts: {} as KanbanCardProps["pipelinePorts"], onOpenSheet: noop, onPipelineMenu: noop,
  onStagePanelFold: noop, onStagePanelClose: noop, onStagePanelMenu: noop, onAddAgent: noop, onAsked: noop, onAnswer: noop, onDismiss: noop, onUndoDismiss: noop,
} as unknown as KanbanCardProps);

const VARIANT_NAME: Record<Locale, string[]> = {
  uk: ["Оригінал · як зараз на проді", "Варіант 1 · Причина в розгорнутій картці", "Варіант 2 · Хронологія задачі", "Варіант 3 · Лише рішення"],
  en: ["Original · as on production now", "Variant 1 · Reason in the opened card", "Variant 2 · Task chronology", "Variant 3 · Decisions only"],
};
const FRAME_NAME: Record<Locale, Record<"board" | "open", string>> = {
  uk: { board: "Дошка, згорнуті картки", open: "Розгорнуті картки" },
  en: { board: "Board, closed cards", open: "Opened cards" },
};

function Band() {
  const scheme = matchMedia("(prefers-color-scheme: dark)").matches ? (LOCALE === "uk" ? "темна" : "dark") : (LOCALE === "uk" ? "світла" : "light");
  return (
    <header className="fr-band" data-fr-band="">
      <span className="fr-band-name">{VARIANT_NAME[LOCALE][VARIANT]}</span>
      <span className="fr-band-meta">{[FRAME_NAME[LOCALE][FRAME], `${WIDTH}`, LOCALE, scheme].join(" · ")}</span>
    </header>
  );
}

/* The frame's one popover: on a board frame, the card the orchestrator holds
   for a stuck commit; an opened frame shows none over its text. */
const POPOVER = "t-voice-head";

function variantCard(card: KanbanCardModel, open: boolean, index: number): ReactNode {
  const lanes = cardLanes(translateT, card, facts);
  const timeline = chronology(translateT, LOCALE, card, lanes, NOW_MS);
  const first = index === 0;
  return (
    <CalmCard
      key={card.id}
      variant={VARIANT as Variant}
      card={card}
      lanes={lanes}
      timeline={timeline}
      nowMs={NOW_MS}
      phone={PHONE}
      open={open}
      popOpen={!open && card.task?.id === POPOVER}
      detailsOpen={open && first}
      historyOpen={open && card.task?.id === "t-node-modules"}
      menuOpen={open && first}
    />
  );
}

function DesktopBoard() {
  const { t } = useLocale();
  return (
    <div className="fr-board">
      {COLUMNS.map((status) => {
        const cards = model.columns[status].cards;
        return (
          <section key={status} className={`column fr-col${status === "assigned" ? " fr-wide" : ""}`} data-status={status}>
            <div className="col-head"><h2>{t(`kanban.status.${status}`)}</h2><span className="n">{cards.length}</span></div>
            <div className="col-body fr-col-body">
              {cards.map((card, index) => VARIANT === 0 ? <KanbanCard key={card.id} {...originalProps(card)} /> : variantCard(card, false, index))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function DesktopOpen() {
  return (
    <div className="fr-open">
      {OPENED.map((id, index) => {
        const card = cardOf(id);
        return <div key={id} className="fr-cell">{VARIANT === 0 ? <KanbanCard {...originalProps(card)} /> : variantCard(card, true, index)}</div>;
      })}
    </div>
  );
}

const phoneInput = {
  project: PROJECT, groups: [], manual: [], files: [], flows: [], pipelines, tasks: [], allTasks: tasks, drafts: [], now: NOW_S, seatRefs: null,
};

function PhoneBoard() {
  const { t } = useLocale();
  if (VARIANT === 0) {
    return (
      <div className="fr-phone-original">
        {COLUMNS.map((status) => (
          <section key={status} className="fr-phone-tab" data-fr-tab={status}>
            <h2 className="fr-phone-tab-name">{t(`kanban.status.${status}`)}</h2>
            <PhoneColumn status={status} />
          </section>
        ))}
      </div>
    );
  }
  return (
    <div className="fr-phone-list">
      {COLUMNS.map((status) => (
        <section key={status} className="fr-phone-tab" data-fr-tab={status}>
          <h2 className="fr-phone-tab-name">{t(`kanban.status.${status}`)}</h2>
          <div className="fr-phone-cards">{model.columns[status].cards.map((card, index) => variantCard(card, false, index))}</div>
        </section>
      ))}
    </div>
  );
}

/* The phone board draws one column at a time, the column a session chose
   for its project. Each column here is its own board under its own project
   key, so the three can stand one under the other. */
const columnBoard = (status: TaskStatus) => {
  const project = `${PROJECT}-${status}`;
  writePlace(project, { column: status });
  return { ...phoneInput, project, allTasks: tasks.map((task) => ({ ...task, project })), pipelines: pipelines.map((pipeline) => ({ ...pipeline, project })) };
};
const PHONE_COLUMNS = Object.fromEntries(COLUMNS.map((status) => [status, columnBoard(status)])) as Record<TaskStatus, typeof phoneInput>;

function PhoneColumn({ status }: { status: TaskStatus }) {
  return (
    <div className="fr-phone-board">
      <MobileKanban {...PHONE_COLUMNS[status]} attention={[]} onOpenTask={noop} onOpenConversation={noop} onOpenPipeline={noop} />
    </div>
  );
}

function PhoneOpen() {
  return (
    <div className="fr-phone-list">
      {OPENED.map((id, index) => (
        <div key={id} className="fr-phone-screen" data-fr-screen={id}>
          {VARIANT === 0 ? (
            <MobileTaskScreen {...phoneInput} taskId={id} onOpenConversation={noop} onOpenPipeline={noop} />
          ) : variantCard(cardOf(id), true, index)}
        </div>
      ))}
    </div>
  );
}

function Page() {
  return (
    <WorkLinksProvider value={workLinks}>
      <div className={`kb fr-page${PHONE ? " fr-phone" : ""}`} data-fr-frame={FRAME} data-fr-variant={VARIANT} style={{ width: WIDTH }}>
        <Band />
        {PHONE ? (FRAME === "board" ? <PhoneBoard /> : <PhoneOpen />) : FRAME === "board" ? <DesktopBoard /> : <DesktopOpen />}
      </div>
    </WorkLinksProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Page />);
