import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { ExternalRelayError } from "@/lib/externalRelay/client";
import { holdPublications, publicationCooldown, pendingOutbound, samePublicationTarget, settleOutbound, type OutboundMessage, type PublicationTarget } from "./outbound";

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
    for (const row of rows) {
      if (this.stopped) return;
      const authorize = () => {
        if (this.stopped || !samePublicationTarget(row.message.target, this.ports.target(row.message.botId))
          || !this.ports.allowed(row.message)) throw new Error("Telegram history publication revoked");
      };
      let published = false;
      let delayMs: number | undefined;
      try {
        const until = await publicationCooldown(this.filename, row.message);
        if (until > this.ports.now()) { await settleOutbound(this.filename, row, false, this.ports.now(), until - this.ports.now()); continue; }
        authorize();
        const result = await this.ports.publish(row.message, authorize);
        published = result === "published";
        if (result === "unavailable" || result === "not_allowed") delayMs = 300000;
      } catch (error) {
        if (error instanceof ExternalRelayError && [403, 404, 429].includes(error.status)) {
          delayMs = error.status === 429 && error.retryAfterSeconds && error.retryAfterSeconds > 0
            ? Math.min(86400000, Math.ceil(error.retryAfterSeconds * 1000)) : 300000;
          await holdPublications(this.filename, row.message, this.ports.now() + delayMs, error.status === 403);
        }
      }
      await settleOutbound(this.filename, row, published, this.ports.now(), delayMs);
    }
  }
}
