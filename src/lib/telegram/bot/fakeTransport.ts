import type { BotCallResult, BotTransport } from "./transport";

/**
 * A scripted {@link BotTransport} for tests: records every call and answers
 * from a per-method queue, then a per-method handler. Nothing reaches the
 * network. `getUpdates` defaults to a long poll that ends only when aborted,
 * so a started poller idles instead of spinning.
 */

export type FakeCall = { method: string; params: Record<string, unknown> };
type Handler = (params: Record<string, unknown>, options: { signal?: AbortSignal }) => BotCallResult | Promise<BotCallResult>;

export function ok<T>(result: T): BotCallResult<T> {
  return { ok: true, result };
}

export function refused(status: number, description: string, parameters: { retryAfterSeconds?: number; migrateToChatId?: string } = {}): BotCallResult<never> {
  return {
    ok: false,
    kind: "http",
    status,
    description,
    retryAfterSeconds: parameters.retryAfterSeconds ?? null,
    migrateToChatId: parameters.migrateToChatId ?? null,
  };
}

export function unreachable(kind: "unreachable" | "network_failed" | "timed_out" = "network_failed"): BotCallResult<never> {
  return { ok: false, kind, status: null, description: null, retryAfterSeconds: null, migrateToChatId: null };
}

/** A token-shaped value that says it is fake, built at runtime so no source
    file carries a token-shaped literal. */
export function fakeBotToken(botId = "4242424"): string {
  return `${botId}:${"not-a-real-token-".repeat(2)}fake`;
}

export class FakeBotTransport implements BotTransport {
  readonly calls: FakeCall[] = [];
  readonly queue: Record<string, BotCallResult[]> = {};
  readonly handlers: Record<string, Handler> = {
    getUpdates: (_params, options) => new Promise((resolve) => {
      if (options.signal?.aborted) return resolve(unreachable());
      options.signal?.addEventListener("abort", () => resolve(unreachable()), { once: true });
    }),
    getWebhookInfo: () => ok({ url: "" }),
  };

  script(method: string, ...results: BotCallResult[]): this {
    (this.queue[method] ??= []).push(...results);
    return this;
  }

  callsOf(method: string): FakeCall[] {
    return this.calls.filter((call) => call.method === method);
  }

  async call<T>(method: string, params: Record<string, unknown>, options: { signal?: AbortSignal } = {}): Promise<BotCallResult<T>> {
    this.calls.push({ method, params });
    const queued = this.queue[method]?.shift();
    if (queued) return queued as BotCallResult<T>;
    const handler = this.handlers[method];
    if (handler) return await handler(params, options) as BotCallResult<T>;
    return refused(400, `unscripted ${method}`) as BotCallResult<T>;
  }
}
