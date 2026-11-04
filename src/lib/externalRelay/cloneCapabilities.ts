import fs from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import { checkApiBase, readRelayJsonUrl, relayCall } from "./client";
import { cloneSendLimitsSchema, cloneSendRightsSchema, type CloneSendLimits, type CloneSendRights } from "./cloneMethods";
import { writeRelayFile, type PairedRelay } from "./store";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";

const TTL = 60000;
const descriptor = z.object({ features: z.array(z.string()), api_base: z.string(),
  limits: z.object({ clone_send: cloneSendLimitsSchema }) });
const rightsPage = z.object({ chats: z.array(z.object({ chat_id: z.number().int().safe().negative(),
  send_rights: cloneSendRightsSchema.nullish().catch(null) })).max(25), next_cursor: z.string().max(4096).nullable() });
const entrySchema = z.object({ identity: z.string(), attemptedAt: z.number(), fetchedAt: z.number(),
  limits: cloneSendLimitsSchema.nullable(), admissions: z.array(z.number()).max(6),
  targets: z.record(z.string(), z.object({ attemptedAt: z.number(),
    chats: z.record(z.string(), cloneSendRightsSchema.nullable()).refine(c => Object.keys(c).length <= 100) })).refine(t => Object.keys(t).length <= 100),
});
type Entry = z.infer<typeof entrySchema>;
const identity = (r: PairedRelay) => createHash("sha256").update(JSON.stringify([r.id, r.origin, r.api_base, r.pairedAt, r.credential])).digest("hex");
export interface CloneCapabilities { limits: CloneSendLimits; rights: CloneSendRights | null }

/** Independent, hard-expiring rights and descriptor caches. Persist the page
 * admissions before HTTP so restarting cannot reset the six-page window. */
export class CloneCapabilitiesDirectory {
  readonly #entries = new Map<string, Entry>();
  readonly #flights = new Map<string, Promise<void>>();
  constructor(private readonly file: string, private readonly relays: () => PairedRelay[], private readonly now: () => number) {
    try {
      if (fs.statSync(file).size > 16 * 1024 * 1024) return;
      const data = z.array(entrySchema).max(100).parse(JSON.parse(fs.readFileSync(file, "utf8")));
      for (const entry of data) if (relays().some(r => identity(r) === entry.identity)) this.#entries.set(entry.identity, entry);
    } catch { /* No valid artifact means no file capability. */ }
  }
  private active(relay: PairedRelay) {
    return !relay.paused && relay.features?.includes("clone_send_methods") === true
      && this.relays().some(r => !r.paused && identity(r) === identity(relay) && r.features?.includes("clone_send_methods"));
  }
  private persist() {
    const live = new Set(this.relays().slice(0, 100).map(identity));
    for (const key of this.#entries.keys()) if (!live.has(key)) this.#entries.delete(key);
    // Evict the oldest target as the bounded artifact fills. Admissions and
    // descriptor evidence survive eviction; only rights need another read.
    while (Buffer.byteLength(JSON.stringify([...this.#entries.values()])) > 8 * 1024 * 1024) {
      const oldest = [...this.#entries.values()].flatMap(entry => Object.entries(entry.targets).map(([id, target]) => ({ entry, id, at: target.attemptedAt })))
        .sort((a, b) => a.at - b.at || a.entry.identity.localeCompare(b.entry.identity) || a.id.localeCompare(b.id))[0];
      if (!oldest) throw new Error("clone capability artifact exceeds its bound");
      delete oldest.entry.targets[oldest.id];
    }
    writeRelayFile(this.file, [...this.#entries.values()]);
  }
  peek(relay: PairedRelay, targetId: string, chatId: string): CloneCapabilities | null {
    if (!this.active(relay)) return null;
    const entry = this.#entries.get(identity(relay));
    if (!entry?.limits || this.now() - entry.fetchedAt >= TTL || entry.fetchedAt > this.now()) return null;
    const rights = entry.targets[targetId]?.chats[chatId];
    const time = rights ? Date.parse(rights.read_at) : 0;
    return { limits: entry.limits, rights: rights && time <= this.now() && this.now() - time < TTL ? rights : null };
  }
  invalidate(relay: PairedRelay, targetId: string) {
    const entry = this.#entries.get(identity(relay));
    const target = entry?.targets[targetId];
    if (!target) return;
    target.chats = {};
    try { this.persist(); } catch { /* Keep the in-memory refusal. */ }
  }
  async refresh(relay: PairedRelay, targetId: string): Promise<void> {
    if (!this.active(relay)) return;
    const key = identity(relay), held = this.#flights.get(key);
    if (held) { await held; return this.refresh(relay, targetId); }
    const work = withViewerOperation("external-relay.clone-capabilities", () => this.fetch(relay, targetId, key));
    this.#flights.set(key, work);
    try { await work; } finally { if (this.#flights.get(key) === work) this.#flights.delete(key); }
  }
  private async fetch(relay: PairedRelay, targetId: string, key: string) {
    const now = this.now();
    let entry = this.#entries.get(key);
    if (!entry) {
      if (this.#entries.size >= 100) return;
      entry = { identity: key, attemptedAt: 0, fetchedAt: 0, limits: null, admissions: [], targets: {} };
      this.#entries.set(key, entry);
    }
    const authorize = () => { if (!this.active(relay) || identity(relay) !== key) throw new Error("pairing changed"); };
    try {
      if (now - entry.attemptedAt >= TTL) {
        entry.attemptedAt = now; entry.limits = null; this.persist();
        const raw = descriptor.parse(await readRelayJsonUrl(`${relay.origin}/.well-known/delegatus-relay.json`));
        authorize(); checkApiBase(relay.origin, raw.api_base);
        if (raw.api_base !== relay.api_base || !raw.features.includes("clone_send_methods")) return;
        entry.limits = raw.limits.clone_send; entry.fetchedAt = this.now(); this.persist();
      }
      if (!entry.limits || this.now() - entry.fetchedAt >= TTL) return;
      if (entry.targets[targetId] && this.now() - entry.targets[targetId].attemptedAt < TTL) return;
      if (!entry.targets[targetId] && Object.keys(entry.targets).length >= 100) return;
      const target = { attemptedAt: this.now(), chats: {} as Record<string, CloneSendRights | null> };
      entry.targets[targetId] = target; this.persist();
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 25000);
      try {
        let cursor: string | null = null;
        const seen = new Set<string>();
        do {
          authorize();
          entry.admissions = entry.admissions.filter(t => this.now() - t < TTL);
          if (entry.admissions.length >= 6) break;
          entry.admissions.push(this.now()); this.persist();
          const response = await relayCall(relay.api_base, `/targets/${encodeURIComponent(targetId)}/chats?include=rights&limit=25${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
            "GET", undefined, relay.credential, { signal: controller.signal, timeoutMs: 0, maxBytes: 1024 * 1024, beforeSend: authorize });
          authorize();
          const page = rightsPage.parse(response.body);
          for (const chat of page.chats) target.chats[String(chat.chat_id)] = chat.send_rights ?? null;
          cursor = page.next_cursor;
          if (cursor && seen.has(cursor)) break;
          if (cursor) seen.add(cursor);
        } while (cursor && Object.keys(target.chats).length < 100);
        authorize(); this.persist();
      } finally { clearTimeout(timer); }
    } catch {
      console.info('[relay clone-capabilities] {"outcome":"unavailable"}');
    }
  }
}
