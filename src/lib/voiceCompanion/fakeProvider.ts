import type { LiveCommand, LiveConnection, LiveProvider } from "./provider";
import type { Locale } from "./contract";

/** Local documented-event provider; owns no network or credential reader.
 * Events use the official Live and nested Responses schemas linked in the
 * research note. A test decides their ordering, including transport loss. */
export class FakeLiveProvider implements LiveProvider {
  readonly commands: LiveCommand[] = [];
  readonly sessions: Array<{ id: string; locale: Locale; sdp: string }> = [];
  private readonly receivers = new Map<string, { event(value: unknown): void; lost(): void }>();
  private readonly disconnected = new Set<string>();
  autoClose = true;
  readonly hangups: string[] = [];
  async hangup(id: string) { this.hangups.push(id); }
  async create(_key: string, locale: Locale, sdp: string) {
    const id = `live_fake_${this.sessions.length + 1}`;
    this.sessions.push({ id, locale, sdp });
    return { id, sdp: "v=0\r\ns=fake-answer\r\n" };
  }
  async attach(id: string, _key: string, event: (value: unknown) => void, lost: () => void): Promise<LiveConnection> {
    this.receivers.set(id, { event, lost });
    return { send: command => {
      if (this.disconnected.has(id)) throw new Error("PROVIDER_ERROR");
      this.commands.push(command);
      if (command.type === "session.close" && this.autoClose)
        queueMicrotask(() => this.replay(id, { type: "session.closed", event_id: `${id}-closed`, reason: "close_requested", session: { id }, usage: { seconds: 18 } }));
    }, dispose: () => { this.receivers.delete(id); } };
  }
  replay(id: string, ...events: unknown[]): void { for (const event of events) this.receivers.get(id)?.event(event); }
  disconnect(id: string): void { this.disconnected.add(id); this.receivers.get(id)?.lost(); }
  get attached() { return this.receivers.size; }
}
