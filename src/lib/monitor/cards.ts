import { redactBounded } from "./redact";
import type { ClassifiedRequest, OperatorRequest, RequestState } from "./types";

/**
 * Board cards the monitor writes (issue #741).
 *
 * A gap that is only reported in chat dies with the conversation, so the
 * monitor's one write is a board card. The card carries a `monitor-ref:` line
 * holding the request's fingerprint, and that line is the whole idempotency
 * story: the next run reads the board back through the API, sees the ref, and
 * correlates the request to its own card instead of minting a second one.
 */

export const MONITOR_REF_PREFIX = "monitor-ref:";
/** Fixed ref of the "no orchestrator could be resolved" card, so the condition
    surfaces once and re-surfaces only after the operator clears it. */
export const ORCHESTRATOR_ALERT_REF = "orchestrator-unresolved";
/** `clientRequestId` for a card create — a second identical create replays. */
export const monitorClientRequestId = (ref: string): string => `monitor-741:${ref}`;

const CARD_TEXT_LIMIT = 5_000;

export const SEAT_TICK_INTERVAL_ELIGIBILITY = "Interval wakes need an eligible agenda: open lanes, readable running workers parented to the seat, or actionable signals. Unparented workers and inbox cards alone provide no eligible interval agenda.";
const INTERVAL_ELIGIBILITY_UK = "Періодичні пробудження потребують відкритих пайплайнів, активних працівників із доступним журналом і батьківським зв’язком з оркестратором або сигналів, що потребують дії. Працівники без батьківського зв’язку й самі картки вхідних не створюють порядку денного для пробудження.";

const STATE_LABEL: Record<RequestState, string> = {
  completed: "completed",
  "in-flight": "in flight",
  stalled: "stalled",
  untracked: "never materialized",
  "awaiting-confirmation": "awaiting operator confirmation",
};

export function stateLabel(state: RequestState): string {
  return STATE_LABEL[state];
}

/** The fingerprint a card was created for, or null for a card the monitor did
    not write. Reading is deliberately lenient: an operator may edit the card
    text above the marker without breaking the correlation. */
export function monitorRefIn(text: string): string | null {
  const match = text.match(/^monitor-ref:\s*([A-Za-z0-9_-]{4,64})\s*$/m);
  return match ? match[1]! : null;
}

/** A task's monitor ref: in its text, or in its `details` for a card whose
    text is meant for the operator alone (an automatic rotation's). */
export function taskMonitorRef(task: { text: string; details?: string }): string | null {
  return monitorRefIn(task.text) ?? (task.details ? monitorRefIn(task.details) : null);
}

function askedLine(request: OperatorRequest): string {
  const when = request.at.slice(0, 16).replace("T", " ");
  return `Asked ${when} UTC in project ${request.project}.`;
}

/**
 * The card body for one classified request.
 *
 * It **summarizes and never quotes**. An earlier draft carried a `> …` block
 * of the operator's own wording, which put private transcript text into an
 * artifact that gets pasted, screenshotted and pushed — and the publication
 * gate cannot catch it, because the gate inspects committed files and this is
 * produced at runtime.
 *
 * What survives is a short derived label (the same normalization the task
 * inbox already applies, redacted and clamped) plus monitor-authored context.
 * That is enough for the operator to recognize the ask and go read the
 * conversation; anything more is republishing it.
 */
export function monitorCardText(classified: ClassifiedRequest): string {
  const { request, state, reason } = classified;
  const lines = [
    request.title,
    "",
    `Surfaced by the conversation monitor — ${stateLabel(state)}.`,
    askedLine(request),
    `Correlation: ${reason}.`,
  ];
  if (state === "awaiting-confirmation") {
    lines.push(
      request.asksForGithubIssue
        ? "Unconfirmed: this reads as a request for a GitHub issue. No GitHub issue was created — the monitor never opens one from inferred intent. Confirm with the operator first."
        : "Unconfirmed: confirm with the operator before acting on this.",
    );
  }
  lines.push(
    "",
    "The line above is the monitor's own summary; the conversation holds what was actually said.",
    "",
    `${MONITOR_REF_PREFIX} ${request.fingerprint}`,
  );
  return redactBounded(lines.join("\n"), CARD_TEXT_LIMIT);
}

/** The card raised when the monitor cannot resolve a live orchestrator. It is
    the reportable condition made durable: the run also fails loudly, but the
    board is where the operator will actually see it. */
export function orchestratorAlertCardText(detail: string, at: string): string {
  return redactBounded(
    [
      "Conversation monitor cannot resolve a live orchestrator",
      "",
      `The monitor resolves the orchestrator through the durable record, never a transcript path. ${detail}.`,
      "Until a live orchestrator is adopted, monitor runs report their findings on the board only — nothing is delivered in chat.",
      `Observed ${at.slice(0, 16).replace("T", " ")} UTC.`,
      "",
      `${MONITOR_REF_PREFIX} ${ORCHESTRATOR_ALERT_REF}`,
    ].join("\n"),
    CARD_TEXT_LIMIT,
  );
}

/* ------------------------------------------------------------------------- *
 * The seat tick's cards (#1245), on the same `monitor-ref:` idempotency.
 *
 * The tick raises the "no active orchestrator seat" condition under
 * {@link ORCHESTRATOR_ALERT_REF} — the very ref the conversation monitor above
 * uses — so the two mechanisms cannot double-card one missing orchestrator.
 * ------------------------------------------------------------------------- */

/** The ref of the card raised when a wake reason has stopped producing change.
    One per reason kind, so two stuck reasons are two readable cards. */
export const seatTickRetryGuardRef = (kind: string): string => `seat-tick-stuck-${kind}`;

/** The ref of the card that says a project's tick is deliberately off or on a
    changed interval (#1275). One per project, because the card is looked up
    inside the project it belongs to — and one standing card, because the
    settings are a standing state rather than a stream of events. */
export const SEAT_TICK_SETTINGS_REF = "seat-tick-settings";

/** The ref of the card that says one of the tick's evidence sources cannot be
    read at all (#1298). One per source, so an outage of the pull-request read
    is one card however long it lasts, and a different source would be its own. */
export const seatTickSourceGapRef = (source: string): string => `seat-tick-source-${source}`;

/** The `monitor-ref:` value a proposal card carries. Colon-free, because that
    is what {@link monitorRefIn} will read back. */
export const seatTickProposalRef = (slot: string): string => `seat-tick-proposal-${slot}`;

/**
 * The card raised when a wake reason has stopped producing any change.
 *
 * The tick then stops re-prompting the same failure and the operator has the
 * record. The mechanism this replaces had no attempt budget anywhere: it
 * re-ran one failing deployment four times in a session, and two of those
 * rollbacks killed every lane on the machine.
 */
export function seatTickRetryGuardCardText(project: string, detail: string, ref: string, at: string): string {
  return redactBounded(
    [
      "Seat tick stopped re-sending a wake reason",
      "",
      `${detail}.`,
      `Project ${project}. Observed ${at.slice(0, 16).replace("T", " ")} UTC.`,
      "The tick resumes this reason on its own once the board or a pipeline moves.",
      "",
      `${MONITOR_REF_PREFIX} ${ref}`,
    ].join("\n"),
    CARD_TEXT_LIMIT,
  );
}

/**
 * The card for an evidence source the tick cannot read at all (#1298).
 *
 * It has to answer, in this order, what a human reading the board will ask:
 * what is broken, since when, and what the tick is doing about it meanwhile.
 * The last one is the point. Wakes continue on every reason that does not
 * depend on the source, so what the card announces is one reason going blind
 * while the rest of the tick carries on.
 *
 * Raised once per outage, so it says how the tick behaves for as long as it
 * stands rather than being re-stated every five minutes.
 */
export function seatTickSourceGapCardText(project: string, detail: string, ref: string, at: string): string {
  return redactBounded(
    [
      "Seat tick cannot read one of its evidence sources",
      "",
      `${detail}.`,
      "Wakes continue on every reason that does not depend on it, and each one names the missing evidence;"
        + " an unmerged pull request left by a finished lane is what cannot be seen while this stands.",
      "The tick keeps asking, at this project's wake interval, and reports nothing further until the source answers"
        + " — this card is raised once per outage.",
      `Project ${project}. Observed ${at.slice(0, 16).replace("T", " ")} UTC.`,
      "",
      `${MONITOR_REF_PREFIX} ${ref}`,
    ].join("\n"),
    CARD_TEXT_LIMIT,
  );
}

/** A tick interval as the card's title words it: exact hours and days collapse,
    anything else stays in minutes — the same rule the panel's chip follows. */
function cardIntervalWord(locale: "en" | "uk", minutes: number): string {
  const uk = locale === "uk";
  if (minutes >= 2880 && minutes % 1440 === 0) return uk ? `кожні ${minutes / 1440} д` : `every ${minutes / 1440} d`;
  if (minutes >= 120 && minutes % 60 === 0) return uk ? `кожні ${minutes / 60} год` : `every ${minutes / 60} h`;
  return uk ? `кожні ${minutes} хв` : `every ${minutes} min`;
}

/**
 * The card for a project whose tick settings depart from the default.
 *
 * Its first line is the setting itself («Tick: every 30 min until 09:24»), so a
 * narrow column still shows the part that matters. Below it the card answers
 * three questions a human reading the board will ask in this order: is this
 * tick off or just slower, why, and who decided. The last one is on the card
 * because a seat may set another project's tick — which is allowed — and the
 * board is where that shows.
 *
 * Written in the operator's language. `detail` is the English clause the seat
 * tick's wake and journal carry; the card composes its own words from the
 * structured `schedule` instead, so the two languages cannot drift apart.
 */
export function seatTickSettingsCardText(input: {
  project: string;
  /** The English clause of the setting, quoted by the English body. The
      Ukrainian body composes its own words from `schedule`. */
  detail: string;
  reason: string | null;
  until: string | null;
  setBy: { kind: string; conversationId: string | null; project: string | null } | null;
  /** When the setting was recorded. NOT when the check ran: a card stamped
      with the check's clock would be rewritten every five minutes. */
  updatedAt: string | null;
  schedule: { enabled: boolean; wakeIntervalMinutes: number };
  locale?: "en" | "uk";
  timeZone?: string | undefined;
}): string {
  const locale = input.locale ?? "en";
  const uk = locale === "uk";
  const clock = (at: string, withDate: boolean): string => {
    const parts = new Intl.DateTimeFormat("en-GB", {
      timeZone: input.timeZone,
      ...(withDate ? { day: "2-digit", month: "2-digit" } : {}),
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).format(new Date(at));
    return withDate ? parts.replace(",", "").replace(/(\d{2})\/(\d{2})/, "$1.$2") : parts;
  };
  const sameDay = (a: string, b: string): boolean => {
    const day = (value: string) => new Intl.DateTimeFormat("en-CA", { timeZone: input.timeZone }).format(new Date(value));
    return day(a) === day(b);
  };
  const validUntil = input.until && !Number.isNaN(Date.parse(input.until)) ? input.until : null;
  /* The date is left out of the title when the setting lapses on the day it
     was recorded, which is the case the title is short for. */
  const titleUntil = validUntil
    ? clock(validUntil, !(input.updatedAt && !Number.isNaN(Date.parse(input.updatedAt)) && sameDay(validUntil, input.updatedAt)))
    : null;
  const schedule = input.schedule.enabled
    ? cardIntervalWord(locale, input.schedule.wakeIntervalMinutes)
    : uk ? "вимкнено" : "off";
  const title = uk
    ? `Тікер: ${schedule}${titleUntil ? ` до ${titleUntil}` : ""}`
    : `Tick: ${schedule}${titleUntil ? ` until ${titleUntil}` : ""}`;
  const actor = (kind: string): string => uk
    ? kind === "manager" ? "призначений оркестратор" : kind === "gateway" ? "власна сесія оператора" : kind === "agent" ? "сесія агента" : "виклик, якого ніщо не ідентифікувало"
    : kind === "manager" ? "the designated seat" : kind === "gateway" ? "the operator's own session" : kind === "agent" ? "an agent session" : "a caller nothing identified";
  const foreign = input.setBy?.project && input.setBy.project !== input.project;
  const who = input.setBy
    ? uk
      ? `Змінив(ла): ${actor(input.setBy.kind)}${input.setBy.conversationId ? ` (${input.setBy.conversationId})` : ""}${foreign ? `, чий власний проєкт — ${input.setBy.project}` : ""}.`
      : `Set by ${actor(input.setBy.kind)}${input.setBy.conversationId ? ` (${input.setBy.conversationId})` : ""}${foreign ? `, whose own project is ${input.setBy.project}` : ""}.`
    : uk ? "Запис не називає, хто це змінив." : "Set by nobody the record names.";
  const recorded = input.updatedAt && !Number.isNaN(Date.parse(input.updatedAt)) ? clock(input.updatedAt, true) : null;
  const lines = uk
    ? [
      title,
      "",
      input.schedule.enabled
        ? `Пробудження цього проєкту йдуть ${schedule}, а не за типовим розкладом.`
        : "Тікер цього проєкту вимкнено: жодне пробудження не надійде, доки його не ввімкнуть знову.",
      INTERVAL_ELIGIBILITY_UK,
      `Вказівки на кожне пробудження: ${input.reason ?? "не записані"}.`,
      validUntil ? `Повернеться до типових налаштувань ${clock(validUntil, true)}.` : "Діє, доки хтось не поверне типові налаштування.",
      who,
      `Проєкт ${input.project}. Записано ${recorded ?? "в невідомий час"}.`,
      "Змінити можна в налаштуваннях тікера; ця картка зникне, щойно проєкт повернеться до типових налаштувань.",
    ]
    : [
      title,
      "",
      `${input.detail.charAt(0).toUpperCase()}${input.detail.slice(1)}.`,
      SEAT_TICK_INTERVAL_ELIGIBILITY,
      `Instructions for every wake: ${input.reason ?? "none recorded"}.`,
      validUntil ? `It returns to the default at ${clock(validUntil, true)}.` : "It stands until someone changes it back.",
      who,
      `Project ${input.project}. Recorded ${recorded ?? "at an unrecorded time"}.`,
      "Change it in the seat tick settings; this card clears itself once the project is back on the defaults.",
    ];
  return redactBounded([...lines, "", `${MONITOR_REF_PREFIX} ${SEAT_TICK_SETTINGS_REF}`].join("\n"), CARD_TEXT_LIMIT);
}
