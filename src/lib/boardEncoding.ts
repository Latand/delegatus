import { createHash } from "node:crypto";
import { diffBoard } from "./boardDelta";

type Json = Record<string, unknown>;
type Base = { value: Json; etag: string; bytes: number; at: number };

export function boardCursorScope(epoch: string, scope: string): string {
  return `${epoch}.${createHash("sha1").update(scope).digest("hex")}`;
}

/** Take ownership of JSON values before stores can mutate them. Undefined
 * object fields are absent on the wire; undefined array cells are null. */
function jsonValue(value: unknown): unknown {
  if (typeof value === "function" || typeof value === "symbol" || value === undefined) return undefined;
  if (typeof value === "number" && !Number.isFinite(value)) return null;
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return Array.from(value, item => jsonValue(item) ?? null);
  if (value instanceof Date) return value.toJSON();
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, jsonValue(item)]).filter(([, item]) => item !== undefined));
}

/** One structured base per active scope. Full JSON remains available for a
 * reset, while steady updates compare values without parsing either body or
 * stringifying unchanged rows. Worker retirement simply causes a full reset. */
export class BoardEncoder {
  private bases = new Map<string, Base>();
  constructor(private limits = { scopes: 4, bytes: 96 * 1024 * 1024, ageMs: 120_000 }) {}

  encode(scope: string, epoch: string, data: Json, now = Date.now()) {
    for (const [key, entry] of this.bases) if (now - entry.at >= this.limits.ageMs) this.bases.delete(key);
    const key = JSON.stringify([epoch, scope]);
    const previous = this.bases.get(key);
    const boardScope = boardCursorScope(epoch, scope);
    const value = jsonValue({ ...data, boardProtocol: 2, boardScope }) as Json;
    const body = JSON.stringify(value);
    const etag = `"${createHash("sha1").update(key).update(body).digest("hex")}"`;
    const bytes = Buffer.byteLength(body);
    const delta = previous && previous.etag !== etag
      ? { base: previous.etag, body: JSON.stringify(diffBoard(previous.value, value, previous.etag, etag)) }
      : undefined;
    this.bases.delete(key);
    if (bytes <= this.limits.bytes) this.bases.set(key, { value, etag, bytes, at: now });
    let total = [...this.bases.values()].reduce((sum, entry) => sum + entry.bytes, 0);
    while (this.bases.size > this.limits.scopes || total > this.limits.bytes) {
      const first = this.bases.keys().next().value!;
      total -= this.bases.get(first)!.bytes;
      this.bases.delete(first);
    }
    return { body, etag, delta, boardScope, stateWrites: (value.systemHealth as { storage?: { writes?: unknown } } | undefined)?.storage?.writes };
  }
}
