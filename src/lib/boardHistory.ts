import { gzipBody } from "./http/gzipBody";

type Link = { etag: string; body: string; bytes: number; at: number };
type Answer = { body: string; gzip?: Promise<Uint8Array>; charged: number };
type Scope = { links: Map<string, Link>; answers: Map<string, Answer>; at: number };
export const BOARD_HISTORY_LIMITS = { scopes: 32, links: 32, path: 16, bytes: 16 * 1024 * 1024, ageMs: 120_000 };

/** Owns only changed values and bounded encoded answers. A slow or evicted
 * client resets from the existing full representation. No full-body history. */
export class BoardHistory {
  private scopes = new Map<string, Scope>();
  constructor(private limits = BOARD_HISTORY_LIMITS) {}

  forget(scope: string): void { this.scopes.delete(scope); }

  private trim(now: number): void {
    for (const [key, scope] of this.scopes) {
      if (now - scope.at >= this.limits.ageMs) this.scopes.delete(key);
      else for (const [base, link] of scope.links) {
        if (now - link.at >= this.limits.ageMs) {
          scope.links.delete(base);
          scope.answers.clear();
        }
      }
    }
    while (this.scopes.size > this.limits.scopes || this.stats().bytes > this.limits.bytes) {
      this.scopes.delete(this.scopes.keys().next().value!);
    }
  }

  stats(): { scopes: number; links: number; bytes: number } {
    let bytes = 0, links = 0;
    for (const scope of this.scopes.values()) {
      links += scope.links.size;
      for (const link of scope.links.values()) bytes += link.bytes;
      for (const answer of scope.answers.values()) bytes += answer.charged;
    }
    return { scopes: this.scopes.size, links, bytes };
  }

  record(scopeKey: string, base: string, etag: string, body: string, now = Date.now()): void {
    this.trim(now);
    if (!base || !etag || base === etag) return;
    const scope = this.scopes.get(scopeKey) ?? { links: new Map(), answers: new Map(), at: now };
    scope.links.delete(base);
    scope.links.set(base, { etag, body, bytes: Buffer.byteLength(body), at: now });
    scope.answers.clear();
    scope.at = now;
    while (scope.links.size > this.limits.links) scope.links.delete(scope.links.keys().next().value!);
    this.scopes.delete(scopeKey);
    this.scopes.set(scopeKey, scope);
    this.trim(now);
  }

  answer(scopeKey: string, from: string, to: string, fullBytes: number, now = Date.now(), fraction = 0.1):
    { answer: Answer; reason?: never } | { answer?: never; reason: "expired" | "delta-too-large" } {
    this.trim(now);
    const scope = this.scopes.get(scopeKey);
    if (!scope) return { reason: "expired" };
    const key = JSON.stringify([from, to]);
    const cached = scope.answers.get(key);
    if (cached) return { answer: cached };
    const deltas: string[] = [];
    const seen = new Set<string>();
    let at = from, bytes = 13; // {"deltas":[]} plus separators below
    while (at !== to) {
      const link = scope.links.get(at);
      if (!link || seen.has(at) || deltas.length >= this.limits.path) return { reason: "expired" };
      seen.add(at);
      bytes += link.bytes + 1;
      if (bytes > fullBytes * fraction) return { reason: "delta-too-large" };
      deltas.push(link.body);
      at = link.etag;
    }
    if (!deltas.length) return { reason: "expired" };
    const body = `{"deltas":[${deltas.join(",")}]}`;
    // Reserve room for identity and gzip (including gzip overhead) before
    // starting asynchronous compression, so concurrent tabs share one job.
    const answer: Answer = { body, charged: Buffer.byteLength(body) * 2 + 128 };
    scope.answers.set(key, answer);
    this.trim(now);
    return { answer };
  }

  gzip(answer: Answer): Promise<Uint8Array> {
    answer.gzip ??= gzipBody(answer.body).catch(error => { answer.gzip = undefined; throw error; });
    return answer.gzip;
  }
}
