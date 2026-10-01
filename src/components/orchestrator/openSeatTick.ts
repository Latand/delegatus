/**
 * A request to open one project's seat tick panel from somewhere that is not
 * its chip: the standing tick notice on the board. The chip owns the popover,
 * so the card only asks and the chip of that project answers.
 */

const EVENT = "llv:open-seat-tick";

/** The standing notice card carries this line (`SEAT_TICK_SETTINGS_REF` in
    `lib/monitor/cards.ts`, which this client module does not import). */
const NOTICE_REF = /^monitor-ref:\s*seat-tick-settings\s*$/m;

export function isSeatTickNotice(text: string | null | undefined): boolean {
  return !!text && NOTICE_REF.test(text);
}

export function requestSeatTickPanel(project: string): void {
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
