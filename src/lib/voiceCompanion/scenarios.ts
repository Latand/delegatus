import type { Locale } from "./contract";
import type { ScriptStep } from "./simulator";

/**
 * The scripted scenarios of the simulated companion (#2519, design note §9).
 * Each is one selectable script on the same event contract; the fixture picks
 * one with `&script=<name>`. The first eight are the operator's list; the last
 * two exist for the browser driver (a quick way to the proposal, and a fill of
 * speech and calls for the edge readings).
 */

export const SCENARIOS = ["short", "three", "paragraph", "long", "many", "burst", "delegation", "interrupt"] as const;
export const DRIVER_SCENARIOS = ["proposal", "edge"] as const;
export type ScenarioName = (typeof SCENARIOS)[number] | (typeof DRIVER_SCENARIOS)[number];

export const isScenario = (value: unknown): value is ScenarioName =>
  typeof value === "string" && ([...SCENARIOS, ...DRIVER_SCENARIOS] as readonly string[]).includes(value);

const TEXT = {
  en: {
    short: "I'm here. What's on your mind?",
    three: ["Got it.", "The search lane is green.", "Nothing needs you right now."],
    paragraph: "Here's how I'd fold the export toggles. Keep three presets for the common cases: quick, full and archive. Move the eleven rare switches into one advanced sheet that opens from the preset menu. Old saved exports keep their keys, so nothing a user saved last month stops working.",
    long: "Here's the whole picture of the release. Four lanes merged since this morning: the retry banner, the queue adapter, the export presets and the account lock fix. Two are still open. The search lane passed its review on the second round and is waiting for the batch merger, which runs every twenty minutes, so it should land within the hour. The billing migration lane is blocked on the external audit, and nothing on our side can move it until they confirm the reconciliation. Main is green, and the last deploy went out at noon without a restart of the runtime host. If you want to cut the release today, the only open question is whether to wait for search. My suggestion is to cut now and let search ride the next minor tomorrow, because it changes nothing a user sees.",
    many: [["Status?", "All green."], ["Search?", "Merging now."], ["Billing?", "Blocked on the audit."], ["Deploy?", "Noon, clean."], ["Anything for me?", "Nothing right now."]],
    burstAsk: "What's on the board right now?",
    burstLook: "Let me look.",
    burstCalls: [
      ["board_snapshot", "Open tasks on the board", "14 open tasks, 3 lanes running"],
      ["list_pipelines", "Open pipelines", "3 open: search, billing, export"],
      ["deployment_status", "This machine's deploy", "main deployed at 12:04"],
      ["account_limits", "Account usage windows", "rate limited, retry in a minute"],
    ],
    burstSummary: "Fourteen open tasks and three lanes running. Main went out at noon. I couldn't read the account limits; I'll try again in a minute.",
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
    remind: "Remind me what the export plan was?",
    longPlan: "The export plan folds the toggles into three presets, quick, full and archive, and moves the eleven rare switches into one advanced sheet that opens from the preset menu, while every saved export keeps its old keys.",
    wait: "Wait, just the presets.",
    presets: "Quick, full and archive.",
  },
  uk: {
    short: "Я тут. Що в тебе на думці?",
    three: ["Зрозумів.", "Смуга пошуку зелена.", "Зараз від тебе нічого не потрібно."],
    paragraph: "Ось як я згорнув би перемикачі експорту. Лишити три пресети для типових випадків: швидкий, повний і архівний. Одинадцять рідкісних перемикачів перенести в один розширений аркуш, що відкривається з меню пресетів. Старі збережені експорти зберігають свої ключі, тож ніщо, збережене минулого місяця, не зламається.",
    long: "Ось уся картина релізу. Від ранку злито чотири смуги: банер повтору, адаптер черги, пресети експорту й виправлення блокування акаунта. Дві ще відкриті. Смуга пошуку пройшла рев’ю з другого кола й чекає пакетного злиття, яке запускається що двадцять хвилин, тож вона має потрапити в main протягом години. Смуга міграції платежів заблокована зовнішнім аудитом, і з нашого боку її не зрушити, доки вони не підтвердять звірку. Main зелений, а останній деплой пройшов опівдні без перезапуску runtime host. Якщо хочеш випустити реліз сьогодні, відкрите лише одне питання: чи чекати на пошук. Я б випустив зараз, а пошук відправив би завтрашнім мінорним релізом, бо він не змінює нічого, що бачить користувач.",
    many: [["Статус?", "Усе зелене."], ["Пошук?", "Зливається."], ["Платежі?", "Чекають на аудит."], ["Деплой?", "Опівдні, чисто."], ["Щось для мене?", "Поки нічого."]],
    burstAsk: "Що зараз на дошці?",
    burstLook: "Зараз подивлюся.",
    burstCalls: [
      ["board_snapshot", "Відкриті задачі на дошці", "14 відкритих задач, 3 смуги в роботі"],
      ["list_pipelines", "Відкриті пайплайни", "3 відкриті: пошук, платежі, експорт"],
      ["deployment_status", "Деплой цієї машини", "main розгорнуто о 12:04"],
      ["account_limits", "Вікна використання акаунтів", "ліміт запитів, повтор за хвилину"],
    ],
    burstSummary: "Чотирнадцять відкритих задач і три смуги в роботі. Main вийшов опівдні. Ліміти акаунтів прочитати не вдалося; спробую ще раз за хвилину.",
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
    remind: "Нагадай, який був план експорту?",
    longPlan: "План експорту згортає перемикачі в три пресети, швидкий, повний і архівний, і переносить одинадцять рідкісних перемикачів в один розширений аркуш, що відкривається з меню пресетів, а кожен збережений експорт зберігає свої старі ключі.",
    wait: "Стоп, лише пресети.",
    presets: "Швидкий, повний і архівний.",
  },
} as const;

export const DEMO_IDS = {
  askItem: "item_op_ask",
  callId: "call_delegate_1",
  proposalId: "proposal_1",
  clientMessageId: "voice-delegation-1",
  operationId: "operation_voice_1",
  reportId: "report_voice_1",
  bargeInItem: "item_op_wait",
  interruptedResponse: "resp_plan",
} as const;

/** The instruction the delegation scenario sends, as it lands in the orchestrator's conversation. */
export const demoInstruction = (locale: Locale): string => TEXT[locale].instruction;
/** The orchestrator's correlated answer in the delegation scenario. */
export const demoAnswer = (locale: Locale): string => TEXT[locale].answer;
/** The scripted text of a scenario's longest companion line, for the driver's readings. */
export const scenarioText = (locale: Locale) => TEXT[locale];

const companion = (n: number | string, text: string, extra: Partial<Extract<ScriptStep, { kind: "companion" }>> = {}): ScriptStep =>
  ({ kind: "companion", itemId: `item_co_${n}`, responseId: `resp_${n}`, text, ...extra });
const operator = (n: number | string, text: string): ScriptStep => ({ kind: "operator", itemId: `item_op_${n}`, text });
const pause = (ms: number): ScriptStep => ({ kind: "pause", ms });

function delegationSteps(locale: Locale): ScriptStep[] {
  const t = TEXT[locale];
  return [
    { kind: "operator", itemId: DEMO_IDS.askItem, text: t.ask },
    { kind: "propose", callId: DEMO_IDS.callId, proposalId: DEMO_IDS.proposalId, sourceItemId: DEMO_IDS.askItem, instruction: t.instruction },
    companion("readback", t.readback),
    {
      kind: "confirm", clientMessageId: DEMO_IDS.clientMessageId, operationId: DEMO_IDS.operationId, settleAfterMs: 1100,
      cancelled: [companion("cancel", t.notSent)],
    },
    companion("sent", t.sent),
    { kind: "answer", reportId: DEMO_IDS.reportId, status: "result", text: t.answer, afterMs: 1800 },
    pause(600),
    /* Spoken with the delegation tool disabled: an answer is a report to explain. */
    companion("explain", t.explain),
  ];
}

export function scenarioScript(name: ScenarioName, locale: Locale): ScriptStep[] {
  const t = TEXT[locale];
  switch (name) {
    case "short":
      return [pause(500), companion(1, t.short)];
    case "three":
      return [pause(500), ...t.three.flatMap((text, index) => [companion(index + 1, text), pause(160)])];
    case "paragraph":
      return [pause(500), companion(1, t.paragraph)];
    case "long":
      return [pause(500), companion(1, t.long)];
    case "many":
      return [pause(400), ...t.many.flatMap(([asked, said], index) => [operator(index + 1, asked), companion(index + 1, said), pause(60)])];
    case "burst":
      return [
        pause(400), operator(1, t.burstAsk), companion(1, t.burstLook),
        { kind: "tools", calls: t.burstCalls.map(([name, summary, result], index) => ({
          callId: `call_read_${index + 1}`, name, summary, result,
          durationMs: [900, 1300, 700, 1600][index]!, outcome: index === 3 ? "failed" as const : "done" as const,
        })) },
        companion(2, t.burstSummary),
      ];
    case "delegation":
      return [
        pause(600), operator(1, t.hello), companion(1, t.here), pause(400),
        /* Ordinary discussion: no tool is proposed for it. */
        operator(2, t.idea), companion(2, t.opinion), pause(400),
        ...delegationSteps(locale),
      ];
    case "interrupt":
      return [
        pause(400), operator(1, t.remind),
        { kind: "companion", itemId: "item_co_plan", responseId: DEMO_IDS.interruptedResponse, text: t.longPlan, bargeIn: { afterMs: 3_200, itemId: DEMO_IDS.bargeInItem, text: t.wait } },
        companion("presets", t.presets),
      ];
    case "proposal":
      return [pause(300), ...delegationSteps(locale)];
    case "edge":
      return [
        pause(300), companion(1, t.three[0]), companion(2, t.three[1]),
        { kind: "tools", calls: t.burstCalls.slice(0, 2).map(([name, summary, result], index) => ({ callId: `call_edge_${index + 1}`, name, summary, result, durationMs: 1_400 + index * 300, outcome: "done" as const })) },
        companion(3, t.three[2]), companion(4, t.short),
      ];
  }
}
