import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { translate } from "@/lib/i18n/core";
import type { PrototypeReviewNotice } from "@/lib/prototypeReview/types";
import { prototypeReviewNotices } from "@/lib/prototypeReview/model";
import { stampAttentionRoutes, waitingRoundIds } from "@/lib/attention/routing";
import { seatAgendaAsks } from "@/lib/attention/seatAgenda";
import type { BoardTask } from "@/lib/tasks/types";
import type { FileEntry } from "@/lib/types";

import { AttentionPanel } from "./AttentionPanel";
import type { MobileAttentionEntry } from "./attentionQueue";
import { MobileAttentionSheet } from "./MobileAttentionSheet";
import { needsYouRowText, prototypeNoticeAsk } from "./needsYouPanel";

const notice: PrototypeReviewNotice = {
  id: "prototype:decision", project: "sample", taskId: "task-choice", reviewId: "decision",
  title: "Choose the provider", roundTitle: "Which provider should handle exports?", asks: "questions",
  createdAt: "2026-10-11T12:00:00.000Z",
  target: { kind: "prototype-review", taskId: "task-choice", reviewId: "decision" },
};

test("a decided form hands its wait back and re-arms the seat while its delivery warning stays visible", () => {
  const now = Date.parse(notice.createdAt) / 1000;
  const worker = {
    root: "claude-projects", name: "worker", path: "/sessions/worker.jsonl", project: notice.project, title: "Worker",
    engine: "claude", kind: "session", fmt: "claude", parent: null, mtime: now - 60, size: 1, activity: "idle",
    proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null, conversationId: "conversation_worker",
    durableLineage: { kind: "spawn", role: "builder", depth: 1, parentConversationId: "conversation_seat", reviewsConversationId: null, memberships: [] },
    operatorAsk: { id: "ask-choice", messageAt: (now - 60) * 1000, gist: notice.roundTitle, state: "open" },
  } as unknown as FileEntry;
  const task = { id: notice.taskId, project: notice.project, text: notice.title, prototypeReview: {
    latestReviewId: notice.reviewId, waitingReviewId: notice.reviewId, title: notice.roundTitle, rounds: 1,
    createdAt: notice.createdAt, asks: "questions",
  } } as unknown as BoardTask;
  const inputs = (source: BoardTask) => {
    const waiting = waitingRoundIds([source]);
    return {
      canonicalProject: (project: string) => project, isSeatConversation: () => false, seatFor: () => "conversation_seat",
      escalation: (key: string) => key === "reason:ask-choice"
        ? { key, at: notice.createdAt, seat: "conversation_seat", taskId: notice.taskId, reviewId: notice.reviewId } : null,
      formWaiting: (reviewId: string) => waiting.has(reviewId),
    };
  };
  stampAttentionRoutes([worker], [], now, inputs(task));
  expect(worker.attentionRoute?.owner).toBe("form");
  expect(seatAgendaAsks({ files: [worker], pipelines: [] }, now, notice.project)).toEqual([]);
  const decided = { ...task, prototypeReview: { ...task.prototypeReview!, waitingReviewId: null,
    decision: { chosen: [], comment: "", at: notice.createdAt, delivery: "failed" as const, phase: "attention" as const },
  } };
  expect(prototypeReviewNotices([decided])).toHaveLength(1);
  expect(prototypeReviewNotices([decided])[0]!.undelivered).toBe(true);
  stampAttentionRoutes([worker], [], now, inputs(decided));
  expect(worker.attentionRoute).toEqual({ key: "reason:ask-choice", owner: "seat", seat: "conversation_seat", returnedFrom: notice.reviewId });
  expect(seatAgendaAsks({ files: [worker], pipelines: [] }, now, notice.project)[0]!.key).toBe("reason:ask-choice@returned:decision");
});

test("an escalated question stays whole; a decided round awaiting delivery keeps the warning and open action", () => {
  for (const locale of ["en", "uk"] as const) {
    const t = (key: Parameters<typeof translate>[1]) => translate(locale, key);
    const waiting = { kind: "prototype", id: notice.id, notice } as const;
    expect(needsYouRowText(t, waiting)).toMatchObject({
      question: notice.roundTitle, line: t("needs.ask.prototypeQuestions"),
    });
    const decided = { ...waiting, notice: { ...notice, undelivered: true as const } };
    expect(needsYouRowText(t, decided)).toMatchObject({ question: null, line: t("proto.notice.undelivered") });
    expect(prototypeNoticeAsk(t, decided.notice)).toEqual({
      question: null, options: [], recommended: null, sentence: t("proto.notice.open"),
    });
  }
});

test("desktop and phone render the question before decision and delivery warning after decision", () => {
  const surfaces = [
    (entry: MobileAttentionEntry) => renderToStaticMarkup(<AttentionPanel queue={[entry]} current="sample" projectNames={{}} pipelines={[]}
      placement="docked" canDock onPlacement={() => {}} onClose={() => {}} onOpen={() => {}} />),
    (entry: MobileAttentionEntry) => renderToStaticMarkup(<MobileAttentionSheet entries={[entry]} now={1_800_000_000}
      onOpenConversation={() => {}} onOpenPrototype={() => {}} onClose={() => {}} screen={{ kind: "board" }} />),
  ];
  for (const render of surfaces) {
    const waiting = render({ kind: "prototype", id: notice.id, notice });
    expect(waiting).toContain(notice.roundTitle!);
    expect(waiting).toContain(translate("en", "needs.ask.prototypeQuestions"));
    const decided = render({ kind: "prototype", id: notice.id, notice: { ...notice, undelivered: true } });
    expect(decided).toContain(translate("en", "proto.notice.undelivered"));
    expect(decided).toContain(translate("en", "proto.notice.open"));
    expect(decided).toContain(translate("en", "proto.notice.undeliveredAria", { title: notice.title }));
    expect(decided).not.toContain(notice.roundTitle!);
    expect(decided).not.toContain(translate("en", "needs.ask.prototypeQuestions"));
    expect(decided).not.toContain("data-needs-you-dismiss=");
  }
});
