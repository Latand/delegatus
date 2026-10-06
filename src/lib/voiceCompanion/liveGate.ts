import { explicitDelegationRequest, gateSentences, retractsRequest, type OperatorInput } from "./gate";

/** A completed turn that says one of these never asks for the orchestrator. */
const DECLINED = new Set(["question", "negated", "retracted", "conditional", "quoted"]);
/** A narrow veto over the source turn while it is still arriving. */
const REFUSED = /\b(?:don['’]?t|do not|never)\s+(?:send|delegate|ask|tell)\b|(?:не\s+(?:надсилай|відправляй|делегуй|прос[иі]|передавай))/iu;
const words = (rows: readonly OperatorInput[]) => rows.map(row => row.text).join(" ");

/**
 * Whether a model-raised Live proposal may stand. `sourceTurn` is the operator's
 * turn when Live delegated: the speech since the companion's previous answer.
 *
 * A completed source turn is read whole by the prototype's gate: an ordinary
 * question, a condition, a retraction, a negation or a quote refuses, and so
 * does a completed turn that never asks for the orchestrator, unless the turns
 * just before it complete the request (a backchannel can split one sentence).
 * Missing input, and a turn still arriving, leave the decision to the model,
 * whose request is sent at once unless it asked the operator to confirm it.
 * Speech in a later turn that takes the request back ("Never mind.", "Cancel
 * that request.", "Забудь.") withdraws a confirmation that waits, finished or
 * still arriving, and is read again when the operator answers it.
 */
export function liveProposalRefusal(instruction: string, inputs: readonly OperatorInput[], sourceTurn?: number): string | null {
  if (!instruction.trim() || instruction.length > 2_000) return "invalid_instruction";
  const turn = sourceTurn ?? inputs.at(-1)?.turn;
  if (turn === undefined) return REFUSED.test(words(inputs.slice(-1)).slice(-800)) ? "operator_refused" : null;
  const source = inputs.filter(row => row.turn === turn);
  if (REFUSED.test(words(inputs.filter(row => (row.turn ?? -1) >= turn)).slice(-2_000))) return "operator_refused";
  if (retractsRequest(words(inputs.filter(row => (row.turn ?? -1) > turn)).slice(-2_000))) return "retracted";
  if (!source.length || source.some(row => !row.final)) return null;
  const verdict = explicitDelegationRequest(words(source));
  if (verdict.admit) return null;
  if (DECLINED.has(verdict.reason)) return verdict.reason;
  for (let back = 1; back <= 2; back += 1) {
    const span = inputs.filter(row => row.turn !== undefined && row.turn >= turn - back && row.turn <= turn);
    if (span.every(row => row.final) && explicitDelegationRequest(words(span)).admit) return null;
  }
  // The prototype's "no_orchestrator" names a missing seat elsewhere; here it means no request was made.
  return "not_requested";
}

const QUOTES = /["“”„«»]/u;
const CALL = String.raw`(?:call|conversation|chat|session|talk)`;
const UK_CALL = String.raw`(?:розмов|дзвін|дзвон|бесід|сесі|сеанс|разговор|звон|бесед|сесси)\p{L}*`;
const UK_START = String.raw`(?:^|[\s,])`;
const UK_CLOSE = String.raw`(?=[\s,.:;!?…]|$)`;
/* Ending the whole voice conversation, in the three languages the operator
   speaks to it: a verb with the call as its object, hanging up, a closing
   verb standing alone ("заверши", "закончим"), or a goodbye. A verb with any
   other object ("finish the task", "заверши завдання") ends a piece of work. */
const END = new RegExp([
  String.raw`\b(?:end|finish|stop|close|terminate|wrap up|leave|quit)\s+(?:(?:the|this|our)\s+)?(?:(?:entire|whole|voice)\s+)*${CALL}\b`,
  String.raw`\bhang\s+up\b`,
  String.raw`\b(?:good\s?bye|bye)\b`,
  String.raw`\b(?:let's|let us|we can|you can)\s+(?:end|finish|stop|wrap up)(?:\s+(?:here|now|there|for now|for today))?(?=[.!?,]|$)`,
  String.raw`\b(?:that's|that is|that will be)\s+all(?:\s+for\s+(?:now|today))?(?=[.!?,]|$)`,
  String.raw`\b(?:i'm|i am|we're|we are)\s+done(?:\s+(?:here|for now|for today))?(?=[.!?,]|$)`,
  String.raw`${UK_START}(?:заверш|закінч|припин|законч|заканчива|прекрат)\p{L}*\s+(?:(?:цю|цей|нашу|наш|эту|этот|всю|весь)\s+)?(?:голосов\p{L}+\s+)?${UK_CALL}${UK_CLOSE}`,
  String.raw`${UK_START}(?:заверши|завершуй|завершити|завершимо|завершуємо|закінчуй|закінчимо|закінчуємо|завершить|завершай|завершаем|закончим|заканчиваем|закругляемся|закругляймося)(?=[.!?…]|$)`,
  String.raw`${UK_START}(?:клади|поклади|положи|вішай|вешай)\s+(?:трубк|слухавк)\p{L}+${UK_CLOSE}`,
  String.raw`${UK_START}(?:бувай|до\s+побачення|до\s+свидания|на\s+все\s+добре)${UK_CLOSE}`,
].join("|"), "u");
const END_CONDITION = /\b(?:if|unless|maybe|perhaps|in case|whether|when|once|after|until|before|only|as soon as)\b|(?:^|[\s,])(?:якщо|якби|можливо|мабуть|чи|коли|щойно|після|доки|поки|лише|тільки|если|когда|после|пока|только|возможно)(?=[\s,]|$)/u;
const END_NEGATION = /\b(?:not|never|don't|dont|do not)\b|n't\b|(?:^|[\s,])(?:не|ніколи|никогда)(?=[\s,]|$)/u;
const END_POLITE = /^(?:(?:can|could|shall|should|may|will|would)\s+(?:we|you|i)\b|(?:можеш|можете|можемо|можна|можешь|можем|можно|давай)(?=[\s,]))/u;

/** Whether one utterance, read whole, asks to end the entire voice conversation. */
export function explicitEndRequest(utterance: string): { admit: true } | { admit: false; reason: string } {
  if (QUOTES.test(utterance)) return { admit: false, reason: "quoted" };
  const all = gateSentences(utterance);
  const last = all.findLastIndex(sentence => END.test(sentence));
  if (last === -1) return { admit: false, reason: "not_requested" };
  for (const [at, sentence] of all.entries()) {
    if (!END.test(sentence)) {
      // Taken back after it was said ("End the call. Actually, wait."), or the talk went on to a question.
      if (at > last && retractsRequest(sentence)) return { admit: false, reason: "retracted" };
      if (at > last && sentence.includes("?")) return { admit: false, reason: "question" };
      continue;
    }
    if (END_CONDITION.test(sentence)) return { admit: false, reason: "conditional" };
    if (END_NEGATION.test(sentence)) return { admit: false, reason: "negated" };
    if (sentence.includes("?") && !END_POLITE.test(sentence)) return { admit: false, reason: "question" };
  }
  return { admit: true };
}

/**
 * Whether the model's `end_conversation` call may close the session. The
 * operator's turn when Live delegated is read as it stands, finished or still
 * arriving: it must ask to end the whole conversation. A question, a quote, a
 * condition, a negation or finishing a piece of work refuses, and so does
 * later speech that takes the request back. With no operator speech on record
 * the model's reading stands, as it does for a proposal.
 */
export function liveEndRefusal(inputs: readonly OperatorInput[], sourceTurn?: number): string | null {
  const turn = sourceTurn ?? inputs.at(-1)?.turn;
  const source = turn === undefined ? inputs.slice(-1) : inputs.filter(row => row.turn === turn);
  if (!source.length) return null;
  if (turn !== undefined && retractsRequest(words(inputs.filter(row => (row.turn ?? -1) > turn)).slice(-2_000))) return "retracted";
  const verdict = explicitEndRequest(words(source));
  if (verdict.admit) return null;
  // A backchannel can split the request from the words that follow it.
  if (turn !== undefined && verdict.reason === "not_requested") for (let back = 1; back <= 2; back += 1)
    if (explicitEndRequest(words(inputs.filter(row => row.turn !== undefined && row.turn >= turn - back && row.turn <= turn))).admit) return null;
  return verdict.reason;
}
