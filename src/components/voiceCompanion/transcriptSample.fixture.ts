import type { Locale } from "@/lib/voiceCompanion/contract";
import { scenarioText, DEMO_IDS } from "@/lib/voiceCompanion/scenarios";
import type { SessionTranscriptRecord, TranscriptEntry } from "@/lib/voiceCompanion/transcriptRecord";

/*
 * A voice session's transcript record as the session route serves it
 * (`GET /api/voice-companion/session?view=transcript`, `transcriptRecord.ts`),
 * for the transcript view's rendered evidence and tests. It ends where the
 * `delegation` scenario ends, so the lane on screen and the record agree:
 * short and long utterances, replies, a read call that worked and one that was
 * refused, and a request sent to the orchestrator with its answer. The session
 * is still open (no end entry). Shapes follow `liveSession.ts` and
 * `admission.ts`: speech with its provider timings, tools with cleaned pretty
 * JSON, the request with its delivery states, the hand-offs to the voice.
 */

const TEXT = {
  en: {
    hello: "Hi Delegatus. Are you there?",
    here: "Here. What are we doing?",
    board: "What's on the board right now?",
    boardAnswer: "Fourteen tasks: three in the inbox, seven in progress, four done. The search lane is waiting for the merge.",
    open: "And the retry banner one, open it.",
    refused: "I can't open that one because it belongs to another project. I can read the tasks of the project on screen.",
    long: "Right, so here's what I keep thinking about. The export settings have grown to fourteen switches, and nobody uses most of them. Last week I watched someone scroll past all of them twice before finding the archive option, and that was me. I want three presets for the common cases and one place for the rest, without breaking anything people saved before.",
    longReply: "That's the right instinct. Three presets for the common cases, the rare switches behind one advanced sheet, and the old saved keys still readable, so nothing anyone saved last month changes under them.",
    tasks: [
      ["Fold the export toggles into presets", "in progress"],
      ["Search lane: merge after review", "in progress"],
      ["Billing migration: wait for the audit", "blocked"],
      ["Retry banner copy", "done"],
    ],
  },
  uk: {
    hello: "Привіт, Делегатусе. Ти тут?",
    here: "Тут. Що робимо?",
    board: "Що зараз на дошці?",
    boardAnswer: "Чотирнадцять задач: три у вхідних, сім у роботі, чотири готові. Смуга пошуку чекає на злиття.",
    open: "А ту, що з банером повтору, відкрий.",
    refused: "Цю я не відкрию, бо вона з іншого проєкту. Задачі проєкту на екрані можу прочитати.",
    long: "Так, слухай, ось про що я весь час думаю. Налаштування експорту розрослися до чотирнадцяти перемикачів, і більшістю ніхто не користується. Минулого тижня я бачив, як людина двічі прогорнула їх усі, поки знайшла архівний варіант, і цією людиною був я. Хочу три пресети для типових випадків і одне місце для решти, і щоб нічого, збереженого раніше, не зламалося.",
    longReply: "Правильний хід. Три пресети для типових випадків, рідкісні перемикачі за одним розширеним аркушем, а старі збережені ключі лишаються читабельними, тож нічого, збереженого минулого місяця, під людьми не зміниться.",
    tasks: [
      ["Згорнути перемикачі експорту в пресети", "у роботі"],
      ["Смуга пошуку: злиття після рев’ю", "у роботі"],
      ["Міграція платежів: чекати на аудит", "заблоковано"],
      ["Текст банера повтору", "готово"],
    ],
  },
} as const;

const json = (value: unknown) => JSON.stringify(value, null, 2);

/** Fragments of a line spoken from `start` to `end`, with the pauses a real reply has at sentence ends. */
function fragments(text: string, start: number, end: number): Array<[number, number]> {
  const words = text.split(/\s+/u).length;
  const pieces = Math.max(1, Math.round(words / 4));
  const step = (end - start) / pieces;
  return Array.from({ length: pieces }, (_, index) => [Math.round(start + index * step), Math.round(start + (index + 1) * step - 40)]);
}

export function sampleTranscript(locale: Locale, project = "atlas"): SessionTranscriptRecord {
  const s = TEXT[locale];
  const t = scenarioText(locale);
  const entries: TranscriptEntry[] = [];
  const add = (entry: Omit<TranscriptEntry, "order">) => entries.push({ ...entry, order: entries.length });
  const speech = (id: string, speaker: "operator" | "companion", text: string, startMs: number, endMs: number) =>
    add({ id, kind: speaker === "operator" ? "utterance" : "reply", atMs: startMs, data: { text, final: true, startMs, endMs, fragments: fragments(text, startMs, endMs) } });
  const recipient = { project, conversationId: "conversation_orchestrator", seatEpoch: 1, engine: "claude" as const };

  add({ id: "start", kind: "session_start", atMs: 0, data: { createdAt: Date.UTC(2026, 9, 9, 23, 14, 5), locale, voice: "meridian" } });
  speech("item_op_1", "operator", s.hello, 900, 2_300);
  speech("item_co_1", "companion", s.here, 2_900, 4_100);

  speech("item_op_board", "operator", s.board, 8_600, 10_000);
  add({ id: "delegation-dlg_board", kind: "delegation", atMs: 10_200, data: { delegationId: "dlg_board", sourceTurn: 2 } });
  const rows = s.tasks.map(([title, state], index) => ({ handle: `task_${index + 1}`, title, state }));
  add({ id: "tool-call_board", kind: "tool", atMs: 10_600, data: {
    name: "list_tasks", callId: "call_board", delegationId: "dlg_board", arguments: json({}), status: "done",
    result: json({ total: 14, rows, speech: `14 tasks. ${rows.map((row) => `${row.title}: ${row.state}`).join(". ")}`, truncated: true }),
  } });
  add({ id: "handoff-board", kind: "handoff", atMs: 11_400, data: { delegationId: "dlg_board", text: `14 tasks. ${rows.slice(0, 2).map((row) => `${row.title}: ${row.state}`).join(". ")}.` } });
  speech("item_co_board", "companion", s.boardAnswer, 11_900, 18_200);

  speech("item_op_open", "operator", s.open, 24_100, 26_000);
  add({ id: "delegation-dlg_open", kind: "delegation", atMs: 26_200, data: { delegationId: "dlg_open", sourceTurn: 3 } });
  add({ id: "tool-call_open", kind: "tool", atMs: 26_700, data: {
    name: "get_task", callId: "call_open", delegationId: "dlg_open", arguments: json({ taskId: "task_retry_banner" }), status: "failed",
    code: "PROJECT_REFUSED", reason: "project refused",
    result: json({ status: "refused", code: "PROJECT_REFUSED", reason: "project refused", speech: "The tool failed: project refused." }),
  } });
  add({ id: "handoff-open", kind: "handoff", atMs: 27_100, data: { delegationId: "dlg_open", text: "The tool failed: project refused." } });
  speech("item_co_open", "companion", s.refused, 27_600, 33_400);

  speech("item_op_long", "operator", s.long, 41_000, 63_500);
  speech("item_co_long", "companion", s.longReply, 64_200, 74_800);
  speech("item_op_2", "operator", t.idea, 80_300, 84_900);
  speech("item_co_2", "companion", t.opinion, 85_500, 94_100);

  speech(DEMO_IDS.askItem, "operator", t.ask, 99_800, 102_600);
  add({ id: "delegation-dlg_send", kind: "delegation", atMs: 102_800, data: { delegationId: "dlg_send", sourceTurn: 7 } });
  add({ id: `tool-${DEMO_IDS.callId}`, kind: "tool", atMs: 103_300, data: {
    name: "request_orchestrator_delegation", callId: DEMO_IDS.callId, delegationId: "dlg_send",
    arguments: json({ instruction: t.instruction, confirmation_reason: null }), status: "done",
    result: json({ status: "sent", delivery: "delivered", speech: "Sent to the orchestrator." }),
  } });
  const proposal = { authority: "live-model", proposalId: DEMO_IDS.proposalId, callId: DEMO_IDS.callId, sourceItemId: DEMO_IDS.askItem, instruction: t.instruction, recipient };
  add({ id: `request-${DEMO_IDS.callId}`, kind: "request", atMs: 103_400, data: {
    ...proposal, status: "delivered", updatedAtMs: 104_900,
    delivery: { proposalId: DEMO_IDS.proposalId, callId: DEMO_IDS.callId, clientMessageId: DEMO_IDS.clientMessageId, operationId: DEMO_IDS.operationId, recipient },
    states: [{ atMs: 103_300, status: "proposed" }, { atMs: 103_400, status: "sending" }, { atMs: 104_900, status: "delivered" }],
  } });
  add({ id: "handoff-send", kind: "handoff", atMs: 105_000, data: { delegationId: "dlg_send", text: "Sent to the orchestrator." } });
  speech("item_co_sent", "companion", t.sent, 105_600, 108_100);
  add({ id: `report-${DEMO_IDS.reportId}`, kind: "report", atMs: 151_200, data: {
    status: "result", text: t.answer,
    delivery: { proposalId: DEMO_IDS.proposalId, callId: DEMO_IDS.callId, clientMessageId: DEMO_IDS.clientMessageId, operationId: DEMO_IDS.operationId, recipient },
  } });
  speech("item_co_explain", "companion", t.explain, 152_400, 160_900);
  return { entries, truncated: false };
}
