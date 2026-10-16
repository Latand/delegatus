import { isRuntimeHostTransportFailure, type RuntimeHostClient, type RuntimeEffectPage } from "./client";
import type { RuntimePendingEffect } from "./contracts";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
const MAX_PAGES = 32;
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_STALE_MS = 30_000;
// A conservative size estimate avoids serializing a large frame a second
// time on the Viewer loop. Bound traversal as well as retained bytes.
function retainedBytes(value: unknown): number {
  const pending: unknown[] = [value];
  let bytes = 0, visited = 0;
  while (pending.length) {
    if (++visited > 4096 || bytes > MAX_BYTES) return Infinity;
    const item = pending.pop();
    if (typeof item === "string") bytes += item.length * 6 + 16;
    else if (item && typeof item === "object") {
      bytes += 64;
      for (const key in item) {
        if (pending.length + visited > 4096) return Infinity;
        bytes += key.length * 6 + 16;
        pending.push((item as Record<string, unknown>)[key]);
      }
    } else bytes += 16;
  }
  return bytes;
}
type Page = { version?: string; effects: RuntimePendingEffect[]; checkedAt: number; bytes: number };

/** Owned by one delivery controller. Conditional reads transfer only a write
    witness on unchanged input. Transport failures can reuse known effects;
    every actuation still reads its own durable status and writer fences.
    Cached absence never authorizes input. LRU/byte/age bounds evict pages. */
export class DeliveryEffectPages {
  private readonly pages = new Map<string, Page>();
  private bytes = 0;
  constructor(private readonly client: RuntimeHostClient, private readonly retry: () => void, private readonly now = () => performance.now()) {}
  read(kinds?: readonly string[], afterEventSeq = 0): Promise<RuntimePendingEffect[]> {
    return withViewerOperation("runtime.delivery-list", async () => {
      // Supersedence is authority: a stale list cannot decide which requested
      // configuration is current. Keep that narrow reader live and failable.
      if (kinds?.length === 1 && kinds[0] === "runtime.reconfigure") return this.client.effectBatch(kinds, afterEventSeq);
      const key = JSON.stringify([kinds ?? null, afterEventSeq]);
      for (const [id, page] of this.pages) if (this.now() - page.checkedAt > MAX_STALE_MS) this.drop(id);
      const cached = this.pages.get(key);
      try {
        const result: RuntimeEffectPage = this.client.effectPage
          ? await this.client.effectPage(kinds, afterEventSeq, cached?.version)
          : { effects: await this.client.effectBatch(kinds, afterEventSeq) };
        if ("unchanged" in result) {
          if (!cached || result.version !== cached.version) throw new Error("conditional delivery page has no matching cache");
          // Another lane may have published a newer page while this read
          // waited. Never restore the older body or corrupt byte accounting.
          if (this.pages.get(key) !== cached) return this.pages.get(key)?.effects ?? cached.effects;
          cached.checkedAt = this.now();
          this.pages.delete(key); this.pages.set(key, cached);
          return cached.effects;
        }
        if (this.pages.get(key) !== cached) return result.effects;
        const bytes = retainedBytes(result.effects);
        this.drop(key);
        if (bytes <= MAX_BYTES) {
          this.pages.set(key, { effects: result.effects, version: result.version, checkedAt: this.now(), bytes });
          this.bytes += bytes;
          while (this.pages.size > MAX_PAGES || this.bytes > MAX_BYTES) this.drop(this.pages.keys().next().value!);
        }
        return result.effects;
      } catch (error) {
        const fallback = this.pages.get(key);
        if (!fallback || this.now() - fallback.checkedAt > MAX_STALE_MS || !isRuntimeHostTransportFailure(error)) throw error;
        this.retry();
        return fallback.effects;
      }
    });
  }
  private drop(key: string): void {
    const page = this.pages.get(key);
    if (page) this.bytes -= page.bytes;
    this.pages.delete(key);
  }
}
