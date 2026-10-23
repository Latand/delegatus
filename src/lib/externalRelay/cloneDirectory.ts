import fs from "node:fs";
import { z } from "zod";
import { statePath } from "@/lib/configDir";
import { withViewerOperation } from "@/lib/viewerLoopMonitor";
import { ExternalRelayError, relayCall } from "./client";
import { knownRelay } from "./knownRelays";
import { readRelayStore, writeRelayFile, type PairedRelay } from "./store";

const chatSchema = z.object({ chat_id: z.number().int().safe().negative(), title: z.string().max(1024) });
const targetSchema = z.object({ target_id: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/), name: z.string().max(1024), active: z.boolean(),
  chats: z.array(chatSchema).max(1000), chats_next_cursor: z.string().max(4096).nullable().optional() });
const targetsSchema = z.array(targetSchema).max(100).refine(targets => new Set(targets.map(t => t.target_id)).size === targets.length);
const snapshotSchema = z.object({ relayId: z.string(), apiBase: z.string(), pairedAt: z.string(), fetchedAt: z.number().finite(),
  supported: z.boolean(), targets: targetsSchema }).refine(s => s.targets.every(t => t.chats.length <= 100)
    && s.targets.reduce((sum, t) => sum + t.chats.length, 0) <= 1000);
type Snapshot = z.infer<typeof snapshotSchema>;
const entrySchema = z.object({ relayId: z.string(), apiBase: z.string(), pairedAt: z.string(), attemptedAt: z.number().finite(),
  snapshot: snapshotSchema.nullable() });
type Entry = z.infer<typeof entrySchema>;
export interface CloneRoute { id: string; relay: PairedRelay; targetId: string; name: string }
export interface DiscoveredCloneChat { chatId: string; title: string }
export interface CloneDirectoryPorts { file: string; relays(): PairedRelay[]; now(): number; origin: string }
const same = (entry: Pick<Entry, "relayId" | "apiBase" | "pairedAt">, relay: PairedRelay) =>
  entry.relayId === relay.id && entry.apiBase === relay.api_base && entry.pairedAt === relay.pairedAt;
const SOFT_TTL = 15 * 60000, MIN_FETCH_INTERVAL = 60000;

/** One bounded artifact, no timers. A failed fetch's admission survives a
 * process restart, just like a successful snapshot does. */
export class CloneDirectory {
  readonly #entries = new Map<string, Entry>();
  readonly #flights = new Map<string, Promise<void>>();
  readonly #maps = new WeakMap<Snapshot, Map<string, Snapshot["targets"][number]>>();
  constructor(private readonly ports: CloneDirectoryPorts) {
    try {
      if (fs.statSync(ports.file).size > 128 * 1024 * 1024) return;
      const parsed = z.object({ v: z.literal(1), entries: z.array(entrySchema).max(100) }).parse(JSON.parse(fs.readFileSync(ports.file, "utf8")));
      for (const entry of parsed.entries) {
        const relay = this.relays().find(r => same(entry, r));
        if (relay && (!entry.snapshot || same(entry.snapshot, relay))) this.#entries.set(entry.relayId, entry);
      }
    } catch { /* Missing or invalid artifacts provide no coverage. */ }
  }
  private relays() { return this.ports.relays().filter(r => !r.paused && r.origin === this.ports.origin).slice(0, 100); }
  private persist() {
    const relays = this.relays();
    for (const [id, entry] of this.#entries) if (!relays.some(r => same(entry, r))) this.#entries.delete(id);
    writeRelayFile(this.ports.file, { v: 1, entries: [...this.#entries.values()] });
  }
  private snapshot(relay: PairedRelay) {
    const entry = this.#entries.get(relay.id);
    return entry && same(entry, relay) ? entry.snapshot : null;
  }
  private refresh(relay: PairedRelay): Promise<void> {
    const held = this.#flights.get(relay.id);
    if (held) return held;
    const old = this.#entries.get(relay.id), now = this.ports.now();
    if (old && same(old, relay) && now - old.attemptedAt < MIN_FETCH_INTERVAL) return Promise.resolve();
    const entry: Entry = { relayId: relay.id, apiBase: relay.api_base, pairedAt: relay.pairedAt,
      attemptedAt: now, snapshot: old && same(old, relay) ? old.snapshot : null };
    this.#entries.set(relay.id, entry);
    // Persist admission before HTTP; failure cannot create an unbounded retry loop.
    try { this.persist(); } catch { return Promise.resolve(); }
    const work = withViewerOperation("external-relay.clone-directory", async () => {
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), 5000);
      let outcome = "failed", status: number | null = null;
      const request = (route: string) => relayCall(relay.api_base, route, "GET", undefined, relay.credential,
        { timeoutMs: 0, signal: controller.signal, maxBytes: 1024 * 1024,
          onResponseStatus: value => { status = value; },
          beforeSend: () => { if (!this.relays().some(r => same(entry, r) && r.credential === relay.credential)) throw new Error("pairing changed"); } });
      try {
        let targets: Snapshot["targets"] = [], supported = false;
        try {
          const answer = await request("/targets?include=chats");
          const parsed = z.object({ targets: targetsSchema }).safeParse(answer.body);
          supported = answer.status === 200 && parsed.success;
          if (supported && parsed.success) targets = parsed.data.targets;
        } catch (error) { if (!(error instanceof ExternalRelayError && error.status === 400)) throw error; }
        let total = 0;
        for (const target of targets) {
          target.chats = target.chats.slice(0, Math.min(100, 1000 - total));
          const seen = new Set<string>();
          while (target.chats_next_cursor && target.chats.length < 100 && total + target.chats.length < 1000) {
            const cursor = target.chats_next_cursor;
            if (seen.has(cursor) || seen.size >= 100) break;
            seen.add(cursor);
            const page = await request(`/targets/${encodeURIComponent(target.target_id)}/chats?cursor=${encodeURIComponent(cursor)}&limit=100`);
            const parsed = z.object({ chats: z.array(chatSchema).max(100), next_cursor: z.string().max(4096).nullable() }).parse(page.body);
            target.chats.push(...parsed.chats.slice(0, Math.min(100 - target.chats.length, 1000 - total - target.chats.length)));
            target.chats_next_cursor = parsed.next_cursor;
          }
          total += target.chats.length;
          target.chats_next_cursor = null;
        }
        if (this.relays().some(r => same(entry, r) && r.credential === relay.credential) && this.#entries.get(relay.id) === entry) {
          entry.snapshot = { relayId: relay.id, apiBase: relay.api_base, pairedAt: relay.pairedAt, fetchedAt: this.ports.now(), supported, targets };
          this.persist();
        }
        outcome = supported ? "supported" : "unsupported";
      } catch { /* Preserve the last validated artifact on transport failure. */ }
      finally {
        clearTimeout(timer);
        console.info(`[relay clone-directory] ${JSON.stringify({ outcome, status, elapsedMs: Math.max(0, this.ports.now() - now) })}`);
      }
    });
    this.#flights.set(relay.id, work);
    void work.finally(() => { if (this.#flights.get(relay.id) === work) this.#flights.delete(relay.id); });
    return work;
  }
  private schedule(relay: PairedRelay) {
    const snapshot = this.snapshot(relay);
    if (!snapshot || this.ports.now() - snapshot.fetchedAt >= SOFT_TTL) void this.refresh(relay);
    return snapshot;
  }
  private chatMap(snapshot: Snapshot) {
    let map = this.#maps.get(snapshot);
    if (map) return map;
    map = new Map();
    const ambiguous = new Set<string>();
    for (const target of snapshot.targets) for (const chat of target.chats) {
      const id = String(chat.chat_id);
      if (map.has(id) && map.get(id)!.target_id !== target.target_id) ambiguous.add(id);
      else map.set(id, target);
    }
    for (const id of ambiguous) map.delete(id);
    this.#maps.set(snapshot, map);
    return map;
  }
  peek(chatId: string): CloneRoute | null {
    if (!/^-[1-9]\d*$/.test(chatId)) return null;
    for (const relay of this.relays()) {
      const snapshot = this.schedule(relay);
      if (!snapshot?.supported) continue;
      const target = this.chatMap(snapshot).get(chatId);
      if (target?.active && relay.targets.some(t => t.id === target.target_id && t.enabled))
        return { id: `clone:${relay.id}:${target.target_id}`, relay, targetId: target.target_id, name: target.name };
    }
    return null;
  }
  async route(chatId: string): Promise<CloneRoute | null> {
    // A cold lookup has one five-second budget across pairings, not per pairing.
    const relays = this.relays();
    if (!this.peek(chatId)) await Promise.all(relays.filter(r => !this.snapshot(r)).map(r => this.refresh(r)));
    return this.peek(chatId);
  }
  async discoverChats(): Promise<DiscoveredCloneChat[]> {
    const relays = this.relays();
    await Promise.all(relays.map(relay => {
      const snapshot = this.snapshot(relay);
      return !snapshot || this.ports.now() - snapshot.fetchedAt >= SOFT_TTL ? this.refresh(relay) : Promise.resolve();
    }));
    const chats = new Map<string, DiscoveredCloneChat>();
    for (const relay of relays) {
      const snapshot = this.snapshot(relay);
      if (!snapshot?.supported) continue;
      for (const target of snapshot.targets) {
        if (!target.active || !relay.targets.some(binding => binding.id === target.target_id && binding.enabled)) continue;
        for (const chat of target.chats) {
          const chatId = String(chat.chat_id), route = this.peek(chatId);
          if (route?.relay.id === relay.id && route.targetId === target.target_id) chats.set(chatId, { chatId, title: chat.title });
        }
      }
    }
    return [...chats.values()];
  }
  async idle(): Promise<void> { await Promise.all(this.#flights.values()); }
  valid(route: CloneRoute, chatId: string) {
    const current = this.peek(chatId);
    return !!current && current.id === route.id && current.relay.credential === route.relay.credential && same({
      relayId: route.relay.id, apiBase: route.relay.api_base, pairedAt: route.relay.pairedAt }, current.relay);
  }
  invalidate(route: CloneRoute, kind: "stale" | "unsupported") {
    const entry = this.#entries.get(route.relay.id);
    if (!entry || !same(entry, route.relay) || !entry.snapshot) return;
    entry.snapshot = { ...entry.snapshot, fetchedAt: 0, ...(kind === "unsupported" ? { supported: false } : {}) };
    // The in-memory refusal must take effect even when the artifact cannot be
    // replaced; callers can then safely continue with the bot path.
    try { this.persist(); } catch { /* Keep the in-memory invalidation. */ }
  }
  readTarget(relays = this.relays()): { relay: PairedRelay; targetId: string } | null {
    for (const relay of relays.filter(r => !r.paused && r.origin === this.ports.origin)) {
      const snapshot = this.schedule(relay);
      const target = snapshot?.supported && snapshot.targets.find(t => t.active && relay.targets.some(s => s.id === t.target_id && s.enabled));
      if (target) return { relay, targetId: target.target_id };
    }
    return null;
  }
}
const sharedKey = Symbol.for("delegatus.cloneDirectory");
const shared = globalThis as typeof globalThis & { [sharedKey]?: { file: string; directory: CloneDirectory } };
export function cloneDirectory(): CloneDirectory {
  const file = statePath("external-relay/clone-directory.json");
  if (shared[sharedKey]?.file !== file) shared[sharedKey] = { file, directory: new CloneDirectory({ file,
    relays: () => readRelayStore().relays, now: Date.now, origin: knownRelay("celestia")!.origin }) };
  return shared[sharedKey]!.directory;
}
