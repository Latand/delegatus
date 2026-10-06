import type { Id } from "./contract";

/**
 * The explicit-request gate (#2519, design note §5): whether a delegation the
 * model proposed may be put in front of the operator for confirmation. The
 * simulator calls it before it offers a confirmation, the reducer calls it
 * again before it shows one, and a real adapter calls the same function at
 * its admission seam, so a prompt that misfires cannot open a send.
 *
 * It reads only completed operator input. The grammar is bounded on purpose:
 * one English or Ukrainian imperative at the start of its sentence whose
 * addressee is the orchestrator ("ask the orchestrator…", "send this to the
 * orchestrator…", "попроси оркестратора…", "передай оркестратору…"). A
 * request verb with the orchestrator somewhere later in the sentence ("tell me
 * how the orchestrator works") is a question for the companion and refuses.
 * So does anything else it cannot read as that request: a greeting, a
 * negation, a quotation, a condition, a plain question, an older or missing
 * input. The companion asks instead.
 *
 * The whole completed input is read, every sentence of it. A sentence beside
 * the request that takes it back ("Actually, do not send anything."), makes it
 * conditional ("Only if the build is green."), negates or asks something
 * refuses the input, and so does a retraction or a condition after the request
 * in its own sentence ("…review the plan, but only when the checks pass").
 *
 * Admission is checked again whenever the operator speaks and once more
 * before the send: a proposal lives only while its source is still the
 * operator's last input and still reads as it did when the proposal froze.
 */

export type GateRefusal =
  | "no_input"
  | "not_final"
  | "stale_input"
  | "no_orchestrator"
  | "negated"
  | "retracted"
  | "conditional"
  | "question"
  | "quoted"
  | "not_imperative"
  | "not_addressed"
  | "source_changed"
  | "empty_instruction";

export type GateVerdict = { admit: true } | { admit: false; reason: GateRefusal };

export interface OperatorInput { itemId: Id; text: string; final: boolean }

const INSTRUCTION_LIMIT = 2_000;

const ORCHESTRATOR = /\borchestrator\b|оркестратор/u;
const QUOTES = /["“”„«»]/u;
/* A condition anywhere in the sentence makes the request conditional. */
const CONDITION = /\b(?:if|unless|maybe|perhaps|in case|whether)\b|(?:^|[\s,])(?:якщо|якби|можливо|мабуть|раптом|чи)(?=[\s,]|$)/u;
const NEGATION = /\b(?:not|no|nobody|nothing|never|don't|dont|do not)\b|n't\b|(?:^|[\s,])(?:не|ні|нікому|нічого|ніколи)(?=[\s,]|$)/u;
/* Beside the request a looser condition counts too: "only when…", "лише коли…". */
const FOLLOWUP_CONDITION = /\b(?:when|once|only|provided|assuming)\b|(?:^|[\s,])(?:коли|лише|тільки|хіба|за умови)(?=[\s,]|$)/u;
/* After the request in its own sentence, a clause that says when to send makes
   it conditional: "…review the plan, but only when the checks pass",
   "…перевірити план, але лише коли перевірки пройдуть". */
const TRAILING_CONDITION = /\b(?:when|once|after|until|provided|assuming|as soon as|as long as)\b|(?:^|[\s,])(?:коли|щойно|як тільки|після того|доки|поки|хіба|за умови)(?=[\s,]|$)/u;
/* The one "when" that is the instruction itself: an asking verb whose question
   opens right after the orchestrator and runs to the end of the sentence
   ("ask the orchestrator when the release is", "запитай у оркестратора, коли
   буде реліз"). */
const ASKING_VERB = /(?:^|\s)(?:ask|запитай|запитати|спитай|спитати)(?=\s)/u;
const ASKED_WHEN = /^[\s,:]*(?:when|коли)\s[^,;:—–]*$/u;
/* The operator takes the request back: a retraction marker anywhere, a halt at
   the start of a clause, or a negated sending verb. */
const RETRACTION = new RegExp([
  String.raw`\b(?:actually|never\s?mind|on second thought|scratch that|forget (?:it|that|this|about it)|cancel (?:it|that|this))\b`,
  String.raw`(?:^|[,;:.!?…—–]\s*)(?:wait|hold on|stop|cancel|no)(?![\w'])`,
  String.raw`(?:\b(?:do not|don't|dont|never)|n't)\s+(?:you\s+)?(?:ask|tell|send|forward|pass|delegate|give|hand|message)\b`,
  String.raw`\b(?:send|ask|tell|forward|pass|delegate|message)\s+(?:nothing|nobody|no one)\b`,
  String.raw`(?:^|[\s,])(?:забудь|передумав|передумала|передумали|відбій|неважливо|скасуй)(?=[\s,.:;!?…]|$)`,
  String.raw`(?:^|[,;:.!?…—–]\s*)(?:стривай|зачекай|почекай|чекай|стоп|стій|ні|хоча)(?=[\s,.:;!?…]|$)`,
  String.raw`(?:^|[\s,])не\s+(?:треба|потрібно|варто|проси|питай|запитуй|кажи|передавай|надсилай|відправляй|доручай|пересилай|пиши)(?=[\s,.:;!?…]|$)`,
  String.raw`(?:^|[\s,])(?:нічого|нікому)\s+не(?=\s)`,
].join("|"), "u");

/* The sentence opens with a direct request: an optional address and
   politeness, then the verb. The polite question form ("could you ask…",
   "можеш попросити…") is the one question the grammar admits. */
const EN_ADDRESS = String.raw`(?:(?:hey|ok|okay|so),?\s+)?(?:delegatus[,:]?\s+)?`;
const EN_POLITE = String.raw`(?:please\s+|(?<ask>can|could|would|will)\s+you\s+(?:please\s+)?)?`;
const EN_VERB = String.raw`(?:ask|tell|send|forward|pass|delegate|give|hand|have|get|let|message)\b`;
const UK_ADDRESS = String.raw`(?:(?:слухай|ок|окей),?\s+)?(?:делегатусе[,:]?\s+)?`;
const UK_POLITE = String.raw`(?:будь\s+ласка,?\s+|(?<ask>можеш|можете|могли\s+б\s+ви)\s+(?:будь\s+ласка,?\s+)?)?`;
const UK_VERB = String.raw`(?:попроси(?:ти)?|скажи|сказати|передай|передати|надішли|надіслати|відправ|відправити|доручи|доручити|перешли|переслати|напиши|написати|запитай|запитати|спитай|спитати)(?=[\s,]|$)`;
const OPENING = new RegExp(`^(?:${EN_ADDRESS}${EN_POLITE}${EN_VERB}|${UK_ADDRESS}${UK_POLITE}${UK_VERB})`, "u");

/* The verb's addressee is the orchestrator. English names it as the verb's
   object ("ask the orchestrator", "let the orchestrator know") or after "to"
   with at most a pronoun or a bare noun in between ("send this to the
   orchestrator"). Ukrainian marks it by case: the asking verbs take
   "оркестратора", the telling and sending verbs take "оркестратору". */
const EN_TARGET = String.raw`(?:(?:the|our|my|this)\s+)?(?:project(?:'s)?\s+)?orchestrator(?![\w'])`;
const EN_OBJECT = String.raw`(?:(?:this|that|it|the\s+following|(?:this|that|the|a)\s+(?:message|note|task|request))\s+)?(?:(?:on|over|along)\s+)?`;
const EN_REQUEST = String.raw`(?:(?:ask|tell|message|have)\s+${EN_TARGET}|get\s+${EN_TARGET}\s+to\b|let\s+${EN_TARGET}\s+know\b|(?:send|forward|pass|delegate|give|hand)\s+${EN_OBJECT}to\s+${EN_TARGET})`;
const UK_END = String.raw`(?=[\s,.:;!?…]|$)`;
const UK_OBJECT = String.raw`(?:(?:(?:ось\s+)?це|таке|наступне|(?:це\s+)?(?:повідомлення|завдання|прохання))\s+)?`;
const UK_REQUEST = String.raw`(?:(?:попроси(?:ти)?|запитай|запитати|спитай|спитати)\s+(?:[ув]\s+)?(?:(?:нашого|мого|цього)\s+)?оркестратора${UK_END}|(?:скажи|сказати|передай|передати|надішли|надіслати|відправ|відправити|доручи|доручити|перешли|переслати|напиши|написати)\s+${UK_OBJECT}(?:(?:нашому|моєму|цьому)\s+)?оркестратору${UK_END})`;
const ADDRESSED = new RegExp(`^(?:${EN_ADDRESS}${EN_POLITE}${EN_REQUEST}|${UK_ADDRESS}${UK_POLITE}${UK_REQUEST})`, "u");

const normalize = (text: string) => text.normalize("NFC").replace(/[’ʼ`]/gu, "'").replace(/\s+/gu, " ").trim().toLowerCase();
const sentences = (text: string) => text.split(/(?<=[.!?…])\s+/u).map((part) => part.trim()).filter(Boolean);

/** Whether one completed utterance, read whole, explicitly asks to reach the orchestrator. */
export function explicitDelegationRequest(utterance: string): GateVerdict {
  const text = normalize(utterance);
  if (!text) return { admit: false, reason: "no_input" };
  if (QUOTES.test(utterance)) return { admit: false, reason: "quoted" };
  const all = sentences(text);
  const addressed = all.filter((sentence) => ORCHESTRATOR.test(sentence));
  if (addressed.length === 0) return { admit: false, reason: "no_orchestrator" };
  for (const sentence of addressed) {
    const opening = OPENING.exec(sentence);
    if (!opening) return { admit: false, reason: NEGATION.test(sentence.split(" ")[0] ?? "") ? "negated" : "not_imperative" };
    if (CONDITION.test(sentence)) return { admit: false, reason: "conditional" };
    const request = ADDRESSED.exec(sentence);
    if (!request) {
      /* The verb is addressed to someone or something else. A negation between it and the orchestrator is the more exact reason. */
      const directive = sentence.slice(opening[0].length, sentence.search(ORCHESTRATOR));
      return { admit: false, reason: NEGATION.test(directive) ? "negated" : "not_addressed" };
    }
    if (sentence.includes("?") && !request.groups?.ask) return { admit: false, reason: "question" };
    /* Taken back in the same breath: "ask the orchestrator to review it, actually don't send anything". */
    const tail = sentence.slice(request[0].length);
    if (RETRACTION.test(tail)) return { admit: false, reason: "retracted" };
    if (TRAILING_CONDITION.test(tail) && !(ASKING_VERB.test(request[0]) && ASKED_WHEN.test(tail))) return { admit: false, reason: "conditional" };
  }
  /* The rest of the input is read too. Whatever stands beside the request and
     takes it back, hedges it or cannot be read as part of it refuses the whole
     input: the companion asks which was meant. */
  for (const sentence of all) {
    if (ORCHESTRATOR.test(sentence)) continue;
    if (RETRACTION.test(sentence)) return { admit: false, reason: "retracted" };
    if (NEGATION.test(sentence)) return { admit: false, reason: "negated" };
    if (CONDITION.test(sentence) || FOLLOWUP_CONDITION.test(sentence)) return { admit: false, reason: "conditional" };
    if (sentence.includes("?")) return { admit: false, reason: "question" };
  }
  return { admit: true };
}

/**
 * Whether a proposal may be offered, kept on screen or sent: its source is the
 * operator's last input in this generation, it is complete, and it is an
 * explicit request. `frozenSourceText` is the source as it read when the
 * proposal froze; a source that reads differently now no longer backs it.
 */
export function admitDelegationProposal(input: { sourceItemId: Id; instruction: string; inputs: readonly OperatorInput[]; frozenSourceText?: string }): GateVerdict {
  const instruction = input.instruction.trim();
  if (!instruction || instruction.length > INSTRUCTION_LIMIT) return { admit: false, reason: "empty_instruction" };
  const source = input.inputs.find((candidate) => candidate.itemId === input.sourceItemId);
  if (!source) return { admit: false, reason: "no_input" };
  if (!source.final) return { admit: false, reason: "not_final" };
  /* Anything the operator said after it, finished or not, may change or withdraw it. */
  if (input.inputs.at(-1)?.itemId !== source.itemId) return { admit: false, reason: "stale_input" };
  if (input.frozenSourceText !== undefined && input.frozenSourceText !== source.text) return { admit: false, reason: "source_changed" };
  return explicitDelegationRequest(source.text);
}
