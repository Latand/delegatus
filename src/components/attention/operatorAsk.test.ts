import { expect, test } from "bun:test";

import { translate, type Locale } from "@/lib/i18n/core";
import type { Pipeline } from "@/lib/pipelines/types";
import type { FileEntry } from "@/lib/types";

import { attentionReason } from "../attention";
import { laneStageLabel } from "./decision";
import { conversationOperatorAsk, laneOperatorAsk } from "./operatorAsk";

/*
 * docs/design/attention-auto-resolve.md, acceptance 5: every row the operator
 * still gets says in one plain sentence what to choose or do and what happens
 * next, in English and Ukrainian, and a lane's decision shows the stage's own
 * question and options. The 11:18Z panel showed a lane as «потрібне рішення ·
 * diagnose» and nothing else; that row now carries its question.
 */

const now = Date.parse("2026-10-11T12:00:00Z") / 1000;
const at = new Date((now - 600) * 1000).toISOString();
const t = (locale: Locale) => (key: Parameters<typeof translate>[1], params?: Parameters<typeof translate>[2]) => translate(locale, key, params);

const file = (extra: Partial<FileEntry>): FileEntry => ({
  root: "claude-projects", name: "agent", path: "/t/agent.jsonl", project: "project-a", title: "agent", kind: "session", engine: "claude", fmt: "claude",
  parent: null, mtime: now - 600, size: 1, activity: "idle", proc: null, pid: null, model: null, pendingQuestion: null, waitingInput: null, ...extra,
}) as FileEntry;

const diagnose = (report: object | null, extra: Partial<Pipeline> = {}): Pipeline => ({
  id: "lane", task: "Fix the panel", project: "project-a", state: "needs_decision", createdAt: at, stateDetail: "stage verdict: needs_decision",
  stages: [{ id: "diagnose", kind: "run", role: { roleId: "researcher" } }], cursor: { stageId: "diagnose" },
  runs: [{ stageId: "diagnose", attempts: [{ n: 1, state: "needs_decision", report }] }], ...extra,
}) as unknown as Pipeline;

const verdict = { status: "needs_decision" };

for (const locale of ["en", "uk"] as const) {
  const tr = t(locale);

  test(`${locale}: a lane decision shows the stage's own question and options, and says the stage resumes with the choice`, () => {
    const decision = { question: "Keep the current behaviour or switch to the requested one?", options: ["Keep it", "Switch"], recommended: 1, effect: null };
    const lane = diagnose({ verdict, summary: "long prose", decision });
    const ask = laneOperatorAsk(tr, lane);
    expect(ask.question).toBe(decision.question);
    expect(ask.options).toEqual(["Keep it", "Switch"]);
    expect(ask.recommended).toBe(1);
    const stage = laneStageLabel(tr, lane, "diagnose");
    expect(stage).not.toBe("");
    expect(ask.sentence).toBe(tr("needs.ask.laneOptions", { stage }));
  });

  test(`${locale}: a reported summary is the question when the stage named no options`, () => {
    const ask = laneOperatorAsk(tr, diagnose({ verdict, summary: "Should the panel keep showing cleared rows?" }));
    expect(ask).toMatchObject({ question: "Should the panel keep showing cleared rows?", options: [] });
    expect(ask.sentence.length).toBeGreaterThan(40);
  });

  test(`${locale}: a mechanical stop says what stopped it, and an unstated decision says where to read it`, () => {
    const stopped = laneOperatorAsk(tr, diagnose(null, { stateDetail: "stage host died without output twice; automatic relaunch exhausted" }));
    expect(stopped.question).toBeNull();
    expect(stopped.sentence).toContain("stage host died without output twice");
    const unstated = laneOperatorAsk(tr, diagnose(null));
    expect(unstated.sentence).not.toContain("stage verdict");
  });

  test(`${locale}: every conversation reason has its own sentence, none of them a bare label`, () => {
    const reasons = [
      file({ pendingQuestion: { kind: "question", toolUseId: "q", askedAt: at, questions: [{ question: "Which database?", header: "DB", multiSelect: false, options: [{ label: "Postgres", description: "", recommended: true }, { label: "SQLite", description: "", recommended: false }] }] } as FileEntry["pendingQuestion"] }),
      file({ pendingQuestion: { kind: "plan", toolUseId: "p", askedAt: at } as FileEntry["pendingQuestion"] }),
      file({ pendingPermission: { id: "perm", since: at, tool: "Bash", command: "make deploy" } as FileEntry["pendingPermission"] }),
      file({ stuckDelivery: { state: "delivery-uncertain", since: at } as FileEntry["stuckDelivery"] }),
      file({ path: "spawn:launch", spawn: { state: "failed", admittedAt: (now - 600) * 1000, error: "account signed out" } as FileEntry["spawn"] }),
      file({ memoryKill: { at, limit: "agent", limitBytes: 4 * 2 ** 30, fatal: true } as FileEntry["memoryKill"] }),
      file({ operatorAsk: { id: "ask", messageAt: (now - 600) * 1000, gist: "Merge it now?", state: "open" } as FileEntry["operatorAsk"] }),
      file({ bridgeAsks: [{ id: "report", at, seq: 3, body: "Pick a release day" }] as FileEntry["bridgeAsks"] }),
    ];
    const sentences = reasons.map((entry) => {
      const reason = attentionReason(entry, now)!;
      return conversationOperatorAsk(tr, reason, entry);
    });
    expect(sentences[0]).toMatchObject({ question: "Which database?", options: ["Postgres", "SQLite"], recommended: 0 });
    expect(sentences[2]!.sentence).toContain("make deploy");
    expect(sentences[4]!.sentence).toContain("account signed out");
    expect(sentences[6]!.sentence).toContain("Merge it now?");
    for (const ask of sentences) {
      expect(ask.sentence).toMatch(/[;:]/);
      expect(ask.sentence.length).toBeGreaterThan(50);
    }
    expect(new Set(sentences.map((ask) => ask.sentence)).size).toBe(sentences.length);
  });

  test(`${locale}: a seat's escalation is asked in the seat's words, with what happens next`, () => {
    const entry = file({ operatorAsk: { id: "ask", messageAt: (now - 600) * 1000, gist: "Roll out?", state: "open" } as FileEntry["operatorAsk"],
      attentionEscalation: { key: "reason:ask", at, question: "Roll out tonight or with the release?", options: ["Tonight", "With the release"], recommended: 1, effect: "the deployer starts that rollout", seat: null } });
    const ask = conversationOperatorAsk(tr, attentionReason(entry, now)!, entry);
    expect(ask).toEqual({ question: "Roll out tonight or with the release?", options: ["Tonight", "With the release"], recommended: 1, sentence: tr("needs.ask.escalatedEffect", { effect: "the deployer starts that rollout" }) });
  });
}
