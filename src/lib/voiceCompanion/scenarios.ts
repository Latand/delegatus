import type { Locale } from "./contract";
import type { ScriptStep } from "./simulator";

/**
 * The scripted scenarios of the simulated companion (#2519, design note §9).
 * Each is one selectable script on the same event contract; the fixture picks
 * one with `&script=<name>`. The first eight are the operator's list. The next
 * three came with the read-only board tools (operator amendment 2026-10-06): a
 * question about the board answered from one read call, from several, and a
 * long spoken answer after one, none of which delegates. Every call carries a
 * name from the tool registry (`tools.ts`). The rest exist for the browser
 * driver (a quick way to a confirmation that waits, one answered by voice, a
 * fill of speech and calls for the edge readings, a withdrawal, a whole
 * conversation in `demo`). These scripts and the simulator that plays them are
 * test fixtures and rendered-evidence drivers: the product has no demo, and no
 * setting or production module reaches them. A request to the orchestrator is sent
 * at once; the model asks first only where it judges that it should.
 */

export const SCENARIOS = ["short", "three", "paragraph", "long", "many", "burst", "delegation", "interrupt", "read", "reads", "readLong"] as const;
export const DRIVER_SCENARIOS = ["proposal", "voiceConfirm", "edge", "withdraw", "demo", "demoNoSeat", "readThenAsk", "readThenAskLong", "unconfirmed"] as const;
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
      ["list_tasks", "Tasks on the board", "14 tasks: 3 in the inbox, 7 in progress, 4 done"],
      ["list_pipelines", "Pipelines and their stages", "3 open: search, billing, export"],
      ["agent_activity", "Who is running now", "4 agents working, 1 waiting for you"],
      ["conversation_messages", "The reviewer's recent messages", "that conversation could not be read"],
    ],
    burstSummary: "Fourteen tasks and three pipelines open, with four agents working. I couldn't read the reviewer's conversation; I'll try again in a minute.",
    readAsk: "How many tasks are in progress?",
    readCall: ["list_tasks", "Tasks on the board", "14 tasks: 3 in the inbox, 7 in progress, 4 done"],
    readAnswer: "Seven are in progress, three wait in the inbox and four are done.",
    readsAsk: "Where does the search lane stand, and what did the reviewer say?",
    readsCalls: [
      ["list_pipelines", "Pipelines and their stages", "3 open: search, billing, export"],
      ["get_pipeline", "The search pipeline", "review passed on round two; waiting for the merge"],
      ["conversation_messages", "The reviewer's recent messages", "approved, with one note about the retry test"],
    ],
    readsAnswer: "Search passed its review on the second round and is waiting for the merge. The reviewer approved it with one note: the retry test should cover a timeout.",
    readLongAsk: "Walk me through everything that's running.",
    readLongCall: ["agent_activity", "Who is running now", "4 agents working, 1 waiting for you"],
    readLongAnswer: "Four agents are working, and one is waiting for you. First, the search builder is on its second fix round and has two findings left, both about the retry test. Second, the export reviewer is reading the presets change and has asked nothing so far. Third, the billing migration is paused until the outside audit confirms the reconciliation, so nothing moves there today. Fourth, the release notes agent is collecting the merged changes since this morning. The one waiting for you is the account lock fix: it asks which of two anchors should win. That is the short version. Tell me which one you want in detail.",
    hello: "Hi Delegatus. Are you there?",
    here: "I'm here. What's on your mind?",
    idea: "I'm thinking about folding the export toggles into three presets. Does that sound sane?",
    opinion: "It does. Three presets cover the common cases, and one advanced sheet keeps the rare toggles out of the way. I'd keep the old keys readable.",
    ask: "Ask the orchestrator to review the export plan.",
    instruction: "Review the export plan: three presets and one advanced sheet, with the old keys still readable.",
    readback: "I'm not sure which plan you mean. Shall I ask the atlas orchestrator to review the export plan?",
    unsure: "I am not sure which plan is meant.",
    instructionLong: "Review the export plan end to end: three presets for the common cases (quick, full and archive), one advanced sheet that opens from the preset menu for the eleven rare switches, the old saved keys still readable, and a note on which of last month's saved exports change their defaults.",
    unsureLong: "I am not sure which plan is meant: the presets draft from Monday or the advanced sheet proposal from Thursday.",
    sent: "Sent. I'll tell you when it answers.",
    askCritical: "Tell the orchestrator to delete the old export presets.",
    instructionCritical: "Delete the old export presets: every preset saved before the three new ones.",
    critical: "Deleting the old presets cannot be undone.",
    askAloud: "That deletes the old presets and can't be undone. Shall I send it?",
    yes: "Yes, send it.",
    sentCritical: "Sent. The orchestrator has it now.",
    notSent: "Okay, nothing was sent.",
    hold: "Wait, don't send it yet.",
    dropped: "Okay, I dropped it. Nothing was sent.",
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
      ["list_tasks", "Задачі на дошці", "14 задач: 3 у вхідних, 7 у роботі, 4 готові"],
      ["list_pipelines", "Пайплайни та їхні етапи", "3 відкриті: пошук, платежі, експорт"],
      ["agent_activity", "Хто зараз працює", "4 агенти працюють, 1 чекає на вас"],
      ["conversation_messages", "Останні повідомлення рев’юера", "цю розмову не вдалося прочитати"],
    ],
    burstSummary: "Відкрито чотирнадцять задач і три пайплайни, працюють чотири агенти. Розмову рев’юера прочитати не вдалося; спробую ще раз за хвилину.",
    readAsk: "Скільки задач зараз у роботі?",
    readCall: ["list_tasks", "Задачі на дошці", "14 задач: 3 у вхідних, 7 у роботі, 4 готові"],
    readAnswer: "У роботі сім, три чекають у вхідних і чотири готові.",
    readsAsk: "Що зі смугою пошуку і що сказав рев’юер?",
    readsCalls: [
      ["list_pipelines", "Пайплайни та їхні етапи", "3 відкриті: пошук, платежі, експорт"],
      ["get_pipeline", "Пайплайн пошуку", "рев’ю пройдено з другого кола; чекає на злиття"],
      ["conversation_messages", "Останні повідомлення рев’юера", "схвалено, з однією приміткою про тест повтору"],
    ],
    readsAnswer: "Пошук пройшов рев’ю з другого кола й чекає на злиття. Рев’юер схвалив його з однією приміткою: тест повтору має покривати тайм-аут.",
    readLongAsk: "Розкажи про все, що зараз працює.",
    readLongCall: ["agent_activity", "Хто зараз працює", "4 агенти працюють, 1 чекає на вас"],
    readLongAnswer: "Працюють чотири агенти, і один чекає на вас. Перше: будівник пошуку на другому колі виправлень, лишилося два зауваження, обидва про тест повтору. Друге: рев’юер експорту читає зміну пресетів і поки нічого не питав. Третє: міграція платежів стоїть, доки зовнішній аудит не підтвердить звірку, тож сьогодні там нічого не зрушить. Четверте: агент нотаток релізу збирає злиті від ранку зміни. На вас чекає виправлення блокування акаунта: воно питає, який із двох якорів має перемогти. Це коротка версія. Скажіть, про що розповісти докладніше.",
    hello: "Привіт, Делегатусе. Ти тут?",
    here: "Я тут. Що в тебе на думці?",
    idea: "Думаю згорнути перемикачі експорту в три пресети. Звучить розумно?",
    opinion: "Так. Три пресети покривають типові випадки, а один розширений аркуш ховає рідкісні перемикачі. Старі ключі я б лишив читабельними.",
    ask: "Попроси оркестратора перевірити план експорту.",
    instruction: "Перевір план експорту: три пресети й один розширений аркуш, старі ключі лишаються читабельними.",
    readback: "Я не певен, про який план мова. Попросити оркестратора atlas перевірити план експорту?",
    unsure: "Я не певен, про який план мова.",
    instructionLong: "Перевір план експорту від початку до кінця: три пресети для типових випадків (швидкий, повний і архівний), один розширений аркуш, що відкривається з меню пресетів, для одинадцяти рідкісних перемикачів, старі збережені ключі лишаються читабельними, і примітка про те, які з минуломісячних збережених експортів змінять типові значення.",
    unsureLong: "Я не певен, про який план мова: про чернетку пресетів із понеділка чи про пропозицію розширеного аркуша з четверга.",
    sent: "Надіслав. Скажу, коли він відповість.",
    askCritical: "Скажи оркестратору видалити старі пресети експорту.",
    instructionCritical: "Видали старі пресети експорту: усі, збережені до трьох нових.",
    critical: "Видалення старих пресетів не можна скасувати.",
    askAloud: "Це видалить старі пресети, і скасувати це не вийде. Надсилати?",
    yes: "Так, надсилай.",
    sentCritical: "Надіслав. Оркестратор уже має це прохання.",
    notSent: "Гаразд, нічого не надіслано.",
    hold: "Стривай, поки не надсилай.",
    dropped: "Гаразд, я зняв це прохання. Нічого не надіслано.",
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
  criticalAskItem: "item_op_critical",
  criticalCallId: "call_delegate_2",
  criticalProposalId: "proposal_2",
  criticalClientMessageId: "voice-delegation-2",
  criticalOperationId: "operation_voice_2",
  yesItem: "item_op_yes",
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
type CallText = readonly [name: string, summary: string, result: string];
/** Read-only calls started together; each finishes on its own time. */
const reads = (prefix: string, calls: readonly CallText[], durations: readonly number[], failing = -1): ScriptStep => ({
  kind: "tools",
  calls: calls.map(([name, summary, result], index) => ({
    callId: `call_${prefix}_${index + 1}`, name, summary, result,
    durationMs: durations[index] ?? durations.at(-1)!, outcome: index === failing ? "failed" as const : "done" as const,
  })),
});

/** The default: the request goes to the orchestrator at once, the card shows what was sent, and the answer comes back. */
function delegationSteps(locale: Locale): ScriptStep[] {
  const t = TEXT[locale];
  return [
    { kind: "operator", itemId: DEMO_IDS.askItem, text: t.ask },
    { kind: "propose", callId: DEMO_IDS.callId, proposalId: DEMO_IDS.proposalId, sourceItemId: DEMO_IDS.askItem, instruction: t.instruction },
    { kind: "deliver", clientMessageId: DEMO_IDS.clientMessageId, operationId: DEMO_IDS.operationId, settleAfterMs: 1100, cancelled: [] },
    companion("sent", t.sent),
    { kind: "answer", reportId: DEMO_IDS.reportId, status: "result", text: t.answer, afterMs: 1800 },
    pause(600),
    /* Spoken with the delegation tool disabled: an answer is a report to explain. */
    companion("explain", t.explain),
  ];
}

/** The exception: the model is unsure and asks first. The card waits for a tap; these scripts leave the answer to the driver. */
function confirmationSteps(locale: Locale, readback: Partial<Extract<ScriptStep, { kind: "companion" }>> | null = {}, long = false): ScriptStep[] {
  const t = TEXT[locale];
  return [
    { kind: "operator", itemId: DEMO_IDS.askItem, text: t.ask },
    { kind: "propose", callId: DEMO_IDS.callId, proposalId: DEMO_IDS.proposalId, sourceItemId: DEMO_IDS.askItem, instruction: long ? t.instructionLong : t.instruction, confirm: long ? t.unsureLong : t.unsure },
    ...(readback ? [companion("readback", t.readback, readback)] : []),
    { kind: "deliver", clientMessageId: DEMO_IDS.clientMessageId, operationId: DEMO_IDS.operationId, settleAfterMs: 1100, cancelled: [companion("cancel", t.notSent)] },
  ];
}

/** A request that is hard to undo: the model asks aloud, and the operator's spoken yes sends it through the tool. */
function spokenConfirmationSteps(locale: Locale): ScriptStep[] {
  const t = TEXT[locale];
  return [
    { kind: "operator", itemId: DEMO_IDS.criticalAskItem, text: t.askCritical },
    { kind: "propose", callId: DEMO_IDS.criticalCallId, proposalId: DEMO_IDS.criticalProposalId, sourceItemId: DEMO_IDS.criticalAskItem, instruction: t.instructionCritical, confirm: t.critical },
    companion("askaloud", t.askAloud),
    {
      kind: "deliver", clientMessageId: DEMO_IDS.criticalClientMessageId, operationId: DEMO_IDS.criticalOperationId, settleAfterMs: 1100,
      spoken: { itemId: DEMO_IDS.yesItem, text: t.yes, decision: "send" }, cancelled: [companion("cancel", t.notSent)],
    },
    companion("sentcritical", t.sentCritical),
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
        reads("read", t.burstCalls, [900, 1300, 700, 1600], 3),
        companion(2, t.burstSummary),
      ];
    /* A question about the board, answered from one read call. Nothing is delegated. */
    case "read":
      return [pause(400), operator(1, t.readAsk), reads("one", [t.readCall], [1100]), companion(1, t.readAnswer)];
    /* The same from several read calls. */
    case "reads":
      return [pause(400), operator(1, t.readsAsk), reads("some", t.readsCalls, [800, 1500, 1900]), companion(1, t.readsAnswer)];
    /* A long spoken answer after one read call: the pace and the split into bubbles can be watched. */
    case "readLong":
      return [pause(400), operator(1, t.readLongAsk), reads("long", [t.readLongCall], [1200]), companion(1, t.readLongAnswer)];
    /* A whole conversation for the driver: a greeting, a board question answered from a read call, a request sent
       to the orchestrator at once with its answer, then one the model asks about first and the operator confirms
       by voice. With no orchestrator seat it stops before the delegation. */
    case "demo":
      return [
        pause(500), operator(1, t.hello), companion(1, t.here), pause(400),
        operator("read", t.readAsk), reads("demo", [t.readCall], [1100]), companion("read", t.readAnswer), pause(500),
        ...delegationSteps(locale), pause(700),
        ...spokenConfirmationSteps(locale),
      ];
    case "demoNoSeat":
      return [
        pause(500), operator(1, t.hello), companion(1, t.here), pause(400),
        operator("read", t.readAsk), reads("demo", [t.readCall], [1100]), companion("read", t.readAnswer), pause(500),
        operator("long", t.readLongAsk), reads("demolong", [t.readLongCall], [1200]), companion("long", t.readLongAnswer),
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
      return [pause(300), ...confirmationSteps(locale), companion("sent", t.sent)];
    case "voiceConfirm":
      return [pause(300), ...spokenConfirmationSteps(locale)];
    case "withdraw":
      /* The operator speaks over the question and takes the request back: the card leaves, and nothing is left to send. */
      return [pause(300), ...confirmationSteps(locale, { bargeIn: { afterMs: 1_400, itemId: "item_op_hold", text: t.hold } }).map((step) => (step.kind === "deliver" ? { ...step, cancelled: [] } : step)), companion("dropped", t.dropped)];
    /* A read call and the waiting confirmation in the lane together, so the two kinds of card can be compared side by side. */
    case "readThenAsk": case "readThenAskLong": {
      const [ask, ...rest] = confirmationSteps(locale, null, name === "readThenAskLong");
      return [pause(300), ask!, reads("ask", [t.readCall], [700]), ...rest];
    }
    /* The send's outcome stays unknown: the card says the delivery is not confirmed, and no answer is claimed. */
    case "unconfirmed":
      return [
        pause(300),
        { kind: "operator", itemId: DEMO_IDS.askItem, text: t.ask },
        { kind: "propose", callId: DEMO_IDS.callId, proposalId: DEMO_IDS.proposalId, sourceItemId: DEMO_IDS.askItem, instruction: t.instruction },
        { kind: "deliver", clientMessageId: DEMO_IDS.clientMessageId, operationId: DEMO_IDS.operationId, settleAfterMs: 1100, cancelled: [], unconfirmed: true },
        { kind: "answer", reportId: DEMO_IDS.reportId, status: "result", text: t.answer, afterMs: 600 },
      ];
    case "edge":
      return [
        pause(300), companion(1, t.three[0]), companion(2, t.three[1]),
        reads("edge", t.burstCalls.slice(0, 2), [1_400, 1_700]),
        companion(3, t.three[2]), companion(4, t.short),
      ];
  }
}
