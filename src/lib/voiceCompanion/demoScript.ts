import type { Locale } from "./contract";
import type { ScriptStep } from "./simulator";

/**
 * The scripted demo conversation (#2519, design note §7): a greeting, an
 * ordinary discussion that reaches no tool, an explicit request to ask the
 * orchestrator, the read-back and the confirmation, the delivery and the
 * orchestrator's correlated answer, which the companion then explains.
 */

const TEXT = {
  en: {
    hello: "Hi Delegatus. Are you there?",
    here: "I'm here. What's on your mind?",
    idea: "I'm thinking about folding the export toggles into three presets. Does that sound sane?",
    opinion: "It does. Three presets cover the common cases, and one advanced sheet keeps the rare toggles out of the way. I'd keep the old keys readable.",
    ask: "Ask the orchestrator to review the export plan.",
    instruction: "Review the export plan: three presets and one advanced sheet, with the old keys still readable.",
    readback: "I'll ask the atlas orchestrator to review the export plan. Shall I send it?",
    sent: "Sent. I'll tell you when it answers.",
    notSent: "Okay, nothing was sent.",
    answer: "Export plan reviewed. The three presets hold. One gap: a saved export from last month needs a migration test before the merge.",
    explain: "The orchestrator replied. The plan holds, with one gap: last month's saved exports need a migration test before the merge.",
  },
  uk: {
    hello: "Привіт, Делегатусе. Ти тут?",
    here: "Я тут. Що в тебе на думці?",
    idea: "Думаю згорнути перемикачі експорту в три пресети. Звучить розумно?",
    opinion: "Так. Три пресети покривають типові випадки, а один розширений аркуш ховає рідкісні перемикачі. Старі ключі я б лишив читабельними.",
    ask: "Попроси оркестратора перевірити план експорту.",
    instruction: "Перевір план експорту: три пресети й один розширений аркуш, старі ключі лишаються читабельними.",
    readback: "Попрошу оркестратора atlas перевірити план експорту. Надсилати?",
    sent: "Надіслав. Скажу, коли він відповість.",
    notSent: "Гаразд, нічого не надіслано.",
    answer: "План експорту перевірено. Три пресети тримаються. Одна прогалина: збережений минулого місяця експорт потребує тесту міграції перед злиттям.",
    explain: "Оркестратор відповів. План тримається, з однією прогалиною: старі збережені експорти потребують тесту міграції перед злиттям.",
  },
} as const;

export const DEMO_IDS = {
  askItem: "item_op_3",
  callId: "call_delegate_1",
  proposalId: "proposal_1",
  clientMessageId: "voice-delegation-1",
  operationId: "operation_voice_1",
  reportId: "report_voice_1",
} as const;

/** The instruction the demo delegates, as it lands in the orchestrator's conversation. */
export const demoInstruction = (locale: Locale): string => TEXT[locale].instruction;
/** The orchestrator's correlated answer in the demo. */
export const demoAnswer = (locale: Locale): string => TEXT[locale].answer;

export function demoScript(locale: Locale): ScriptStep[] {
  const t = TEXT[locale];
  return [
    { kind: "pause", ms: 700 },
    { kind: "operator", itemId: "item_op_1", text: t.hello },
    { kind: "companion", itemId: "item_co_1", responseId: "resp_1", text: t.here },
    { kind: "pause", ms: 450 },
    /* Ordinary discussion: no tool is proposed for it. */
    { kind: "operator", itemId: "item_op_2", text: t.idea },
    { kind: "companion", itemId: "item_co_2", responseId: "resp_2", text: t.opinion },
    { kind: "pause", ms: 500 },
    { kind: "operator", itemId: DEMO_IDS.askItem, text: t.ask },
    { kind: "propose", callId: DEMO_IDS.callId, proposalId: DEMO_IDS.proposalId, sourceItemId: DEMO_IDS.askItem, instruction: t.instruction },
    { kind: "companion", itemId: "item_co_3", responseId: "resp_3", text: t.readback },
    {
      kind: "confirm", clientMessageId: DEMO_IDS.clientMessageId, operationId: DEMO_IDS.operationId, settleAfterMs: 1100,
      cancelled: [{ kind: "companion", itemId: "item_co_cancel", responseId: "resp_cancel", text: t.notSent }],
    },
    { kind: "companion", itemId: "item_co_4", responseId: "resp_4", text: t.sent },
    { kind: "answer", reportId: DEMO_IDS.reportId, status: "result", text: t.answer, afterMs: 1800 },
    { kind: "pause", ms: 700 },
    /* Spoken with the delegation tool disabled: an answer is a report to explain. */
    { kind: "companion", itemId: "item_co_5", responseId: "resp_5", text: t.explain },
  ];
}
