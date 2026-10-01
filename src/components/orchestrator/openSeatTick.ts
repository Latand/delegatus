/**
 * A request to open one project's seat tick panel from somewhere that is not
 * its chip: the standing tick notice on the board. The chip owns the popover,
 * so the card only asks and the chip of that project answers.
 *
 * The chip lives in the seat's header, which a folded seat does not draw. The
 * request is therefore also held for a few seconds: the seat unfolds on seeing
 * it, and the chip that mounts with the unfolded header claims it.
 */

const EVENT = "llv:open-seat-tick";
/** How long a request stays claimable by a chip that mounts after it. */
const PENDING_TTL_MS = 5_000;

let pending: { project: string; at: number } | null = null;

/** The standing notice card carries this line (`SEAT_TICK_SETTINGS_REF` in
    `lib/monitor/cards.ts`, which this client module does not import). */
const NOTICE_REF = /^monitor-ref:\s*seat-tick-settings\s*$/m;

export function isSeatTickNotice(text: string | null | undefined): boolean {
  return !!text && NOTICE_REF.test(text);
}

export function requestSeatTickPanel(project: string): void {
  pending = { project, at: Date.now() };
  if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent<string>(EVENT, { detail: project }));
}

export function onSeatTickPanelRequest(handler: (project: string) => void): () => void {
  if (typeof window === "undefined") return () => {};
  const listener = (event: Event) => {
    const project = (event as CustomEvent<string>).detail;
    if (typeof project === "string") handler(project);
  };
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

/** Claim the request held for `project`: true once, and only while it is fresh.
    A chip claims it as the request arrives and again as it mounts. */
export function takePendingSeatTickPanel(project: string): boolean {
  if (!pending || pending.project !== project) return false;
  const fresh = Date.now() - pending.at <= PENDING_TTL_MS;
  pending = null;
  return fresh;
}

/** Forget a held request, for a test that must start from nothing. */
export function resetPendingSeatTickPanel(): void {
  pending = null;
}
