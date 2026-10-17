import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { ExternalRelayError } from "@/lib/externalRelay/client";
import { holdPublications, publicationCooldown, pendingOutbound, samePublicationTarget, reserveOutboundAttempt, settleOutbound, type OutboundMessage, type PublicationTarget } from "./outbound";

export interface OutboundPublicationPorts {
  target(botId: string): PublicationTarget | null;
  allowed(message: OutboundMessage): boolean;
  publish(message: OutboundMessage, authorize: () => void): unknown;
  now(): number;
}

/** One queue per shared bot service. Each tick admits 16 indexed obligations,
 * each with a finite transport deadline. A restart only republishes history;
 * it can never resend a Telegram message. CAS settlement tolerates two Viewer
 * generations publishing the same idempotent service message. */
export class OutboundPublication {
  private running: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  constructor(private readonly filename: string, private readonly ports: OutboundPublicationPorts) {}

  wake(): void {
    if (this.stopped || this.running) return;
    clearTimeout(this.timer);
    this.running = withViewerOperation("telegram.outbound-publication", () => this.drain())
      .catch(() => { console.warn("Telegram outbound publication pending"); })
      .finally(() => {
        this.running = null;
        if (!this.stopped) { this.timer = setTimeout(() => this.wake(), 1000); this.timer.unref(); }
      });
  }
  async idle(): Promise<void> { await this.running; }
  async stop(): Promise<void> { this.stopped = true; clearTimeout(this.timer); await this.running; }

  private async drain(): Promise<void> {
    const rows = await pendingOutbound(this.filename, this.ports.now());
    for (let row of rows) {
      if (this.stopped) return;
      const authorize = () => {
        if (this.ports.now() >= (row.message.date + 86400) * 1000) throw new ExternalRelayError("stale_message", 400);
        if (this.stopped || !samePublicationTarget(row.message.target, this.ports.target(row.message.botId))
          || !this.ports.allowed(row.message)) throw new Error("Telegram history publication revoked");
      };
      if (row.attempts >= 64 || this.ports.now() >= (row.message.date + 86400) * 1000) {
        await settleOutbound(this.filename, { ...row, reserved: true }, false, this.ports.now(), undefined, row.attempts >= 64 ? "attempts_exhausted" : "expired");
        continue;
      }
      let published = false;
      let reason = "unconfirmed";
      let terminalReason: string | undefined;
      let delayMs: number | undefined;
      try {
        const until = await publicationCooldown(this.filename, row.message);
        if (until > this.ports.now()) { await settleOutbound(this.filename, { ...row, reserved: true }, false, this.ports.now(), until - this.ports.now()); continue; }
        authorize();
        const reserved = await reserveOutboundAttempt(this.filename, row, this.ports.now());
        if (!reserved) continue;
        row = reserved;
        authorize();
        const result = await this.ports.publish(row.message, authorize);
        published = result === "published";
        reason = typeof result === "string" ? result : "unconfirmed";
        if (result === "unavailable" || result === "not_allowed") delayMs = 300000;
      } catch (error) {
        const failure = publicationFailure(error);
        ({ delayMs, terminalReason, reason } = failure);
        if (delayMs) await holdPublications(this.filename, row.message, this.ports.now() + delayMs);
      }
      await settleOutbound(this.filename, row, published, this.ports.now(), delayMs, terminalReason, reason);
    }
  }
}

/** Only bounded error codes enter the journal; payloads and credentials never do. */
export function publicationFailure(error: unknown): { reason: string; terminalReason?: string; delayMs?: number } {
  if (!(error instanceof ExternalRelayError) || error.status < 100 || error.status > 599) return { reason: "unconfirmed" };
  const code = /^[a-z][a-z_]{0,39}$/.test(error.code) ? error.code : "refused";
  const reason = `${error.status}:${code}`;
  if (error.status >= 400 && error.status < 500 && ![404, 429].includes(error.status)) return { reason, terminalReason: reason };
  if (error.status === 429) return { reason, delayMs: Math.min(86400000,
    Math.ceil((error.retryAfterSeconds && error.retryAfterSeconds > 0 ? error.retryAfterSeconds : 60) * 1000)) };
  if (error.status === 404) return { reason, delayMs: 300000 };
  return { reason };
}
