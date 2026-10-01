#!/usr/bin/env bun
/**
 * Offline replay of recorded search/open calls. Only aggregate numbers leave
 * this process. No query, snippet, transcript path or project name is printed.
 *
 * First back up the index through a read-only SQLite connection into a private
 * scratch directory. Set LLV_STATE_DIR to that directory; copy the project
 * alias/remote maps there as well to exercise name resolution. Never copy data
 * into the repository. This script migrates only the explicitly chosen copy.
 *
 * LLV_STATE_DIR=<private-copy> bun scripts/transcript-search-replay.ts [--sample 1000] [--pairs 300] [--since <ISO date>]
 */
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import { searchTranscripts } from "@/lib/search/transcriptSearch";
import { appDirIn } from "../bin/appDir.mjs";

export interface RecordedCall {
  tool: string;
  args: Record<string, unknown>;
  timestamp: number;
}
type ReplayQuery = { query: string; project?: string; timestamp: number; source: string; opened?: string };
const object = (v: unknown): Record<string, unknown> | null => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;

/** Claude blocks and both generations of Codex MCP records. */
export function recordedCalls(record: unknown): RecordedCall[] {
  const r = object(record);
  if (!r) return [];
  const timestamp = Date.parse(String(r.timestamp ?? "")) / 1000;
  if (!Number.isFinite(timestamp)) return [];
  const calls: RecordedCall[] = [];
  const add = (name: unknown, args: unknown) => {
    if (typeof name !== "string") return;
    const tool = name.replace(/^mcp__viewer__/u, "");
    if (!["search_transcripts", "conversation_messages", "get_conversation"].includes(tool)) return;
    let parsed = object(args);
    if (typeof args === "string") { try { parsed = object(JSON.parse(args)); } catch { return; } }
    if (parsed) calls.push({ tool, args: parsed, timestamp });
  };
  const content = object(r.message)?.content;
  if (Array.isArray(content)) for (const value of content) {
    const c = object(value);
    if (c?.type === "tool_use") add(c.name, c.input);
  }
  const p = object(r.payload);
  const item = object(p?.item);
  if (p?.type === "item_completed" && item?.type === "McpToolCall" && item.server === "viewer") add(item.tool, item.arguments);
  if (p?.type === "mcp_tool_call_end") {
    const invocation = object(p.invocation);
    if (invocation?.server === "viewer") add(invocation.tool, invocation.arguments);
  }
  if (p?.type === "function_call" || p?.type === "custom_tool_call") add(p.name, p.arguments ?? p.input);
  return calls;
}

export function seededSample<T>(values: readonly T[], count: number, seed: number): T[] {
  const next = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  return values.map((value) => ({ value, key: next() })).sort((a, b) => a.key - b.key).slice(0, count).map((v) => v.value);
}

/** The v4 AND query and newest body collapse, including the historical fence. */
export function baselinePage(db: Database, q: ReplayQuery): { total: number; paths: string[] } {
  const terms = q.query.trim().split(/\s+/u).filter(Boolean);
  if (!terms.length) return { total: 0, paths: [] };
  const expression = terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(" AND ");
  const rows = db.query(`SELECT m.id, m.speaker, m.body_hash, m.sort_timestamp, m.transcript_path
    FROM transcript_messages_fts JOIN transcript_messages m ON m.id = transcript_messages_fts.rowid
    JOIN transcript_files f ON f.path = m.transcript_path
    WHERE transcript_messages_fts MATCH ? AND m.sort_timestamp <= ? AND m.transcript_path != ?
    ${q.project ? "AND f.project = ?" : ""}`)
    .values(expression, q.timestamp, q.source, ...(q.project ? [q.project] : [])) as Array<[number, string, string, number, string]>;
  const groups = new Map<string, { id: number; timestamp: number; path: string }>();
  for (const [id, speaker, hash, timestamp, pathname] of rows) {
    const key = speaker + "\0" + hash;
    const old = groups.get(key);
    if (!old || timestamp > old.timestamp || (timestamp === old.timestamp && id > old.id)) groups.set(key, { id, timestamp, path: pathname });
  }
  const ordered = [...groups.values()].sort((a, b) => b.timestamp - a.timestamp || b.id - a.id);
  return { total: groups.size, paths: [...new Set(ordered.map((g) => g.path))] };
}

export async function runReplay(args: string[]): Promise<void> {
  const flag = (name: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : undefined; };
  const root = process.env.LLV_STATE_DIR;
  const homes = [os.homedir(), process.env.HOME].filter((v): v is string => Boolean(v));
  const protectedRoots = homes.flatMap((home) => [path.join(home, ".config", "agent-log-viewer"), path.join(home, ".config", "delegatus")]);
  protectedRoots.push(appDirIn(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), ".config")));
  if (!root || !fs.existsSync(root)) throw new Error("Replay requires an existing private LLV_STATE_DIR containing a fresh index copy");
  const resolved = fs.realpathSync(root);
  const canonicalProtected = protectedRoots.map((p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } });
  if (canonicalProtected.some((p) => resolved === p || resolved.startsWith(p + path.sep))
    || resolved === process.cwd() || resolved.startsWith(process.cwd() + path.sep)) throw new Error("Replay refuses an operator or repository directory");
  for (let ancestor = resolved; ; ancestor = path.dirname(ancestor)) {
    if (fs.existsSync(path.join(ancestor, ".git"))) throw new Error("Replay refuses an index copy inside a repository");
    if (ancestor === path.dirname(ancestor)) break;
  }
  const filename = path.join(resolved, "transcript-search.sqlite");
  const indexStat = fs.lstatSync(filename);
  if (indexStat.isSymbolicLink() || indexStat.nlink !== 1) throw new Error("Replay requires a separate regular index copy");
  const db = new Database(filename, { readonly: true });
  try {
    const all: ReplayQuery[] = [];
    const pairs: ReplayQuery[] = [];
    const since = Date.parse(flag("since") ?? "1970-01-01") / 1000;
    let filesRead = 0;
    let filesUnavailable = 0;
    for (const { path: pathname, size } of db.query<{ path: string; size: number }, []>("SELECT path, size FROM transcript_files ORDER BY path").all()) {
      if (!fs.existsSync(pathname)) { filesUnavailable++; continue; }
      if (!size) continue;
      // Do not sample calls appended after the index backup was taken.
      const stream = fs.createReadStream(pathname, { encoding: "utf8", end: size - 1 });
      const lines = readline.createInterface({ input: stream, crlfDelay: Infinity });
      const calls: RecordedCall[] = [];
      try {
        for await (const line of lines) {
          if (!/search_transcripts|conversation_messages|get_conversation/u.test(line)) continue;
          try { calls.push(...recordedCalls(JSON.parse(line))); } catch { /* Non-JSON transcript lines carry no calls. */ }
        }
        filesRead++;
      } catch { filesUnavailable++; } finally { lines.close(); stream.destroy(); }
      // End/begin mirrors share request ids; retain one observation per call.
      const deduplicated = [...new Map(calls.map((c) => [`${c.tool}\0${c.args.clientRequestId ?? ""}\0${c.timestamp}\0${JSON.stringify(c.args)}`, c])).values()];
      for (const [i, call] of deduplicated.entries()) {
        if (call.tool !== "search_transcripts" || typeof call.args.query !== "string" || call.timestamp < since) continue;
        const q: ReplayQuery = { query: call.args.query.trim(), timestamp: call.timestamp, source: pathname,
          ...(typeof call.args.project === "string" && call.args.project ? { project: call.args.project } : {}) };
        if (!q.query) continue;
        all.push(q);
        for (const next of deduplicated.slice(i + 1, i + 7)) {
          if (next.tool === "search_transcripts") break;
          if (typeof next.args.transcriptPath === "string" && next.args.transcriptPath !== pathname) {
            pairs.push({ ...q, opened: next.args.transcriptPath }); break;
          }
        }
      }
    }
    const distinct = new Map<string, ReplayQuery>();
    // Preserve first discovery order, updating the earliest call in place:
    // this is the design lane's sampling algorithm, not a time-sorted sample.
    for (const q of all) {
      const key = q.query + "\0" + (q.project ?? "");
      const prior = distinct.get(key);
      if (!prior || q.timestamp < prior.timestamp) distinct.set(key, q);
    }
    const sample = seededSample([...distinct.values()], Number(flag("sample") ?? 1000), 20260926);
    if (!sample.length) throw new Error("No recorded queries were available for replay");
    let zeroBefore = 0, zeroAfter = 0, anyZeroAfter = 0;
    const beforeMs: number[] = [], afterMs: number[] = [];
    const after = (q: ReplayQuery) => searchTranscripts({ query: q.query, project: q.project, order: "relevance", limit: 6,
      fence: { timestamp: q.timestamp, excludeTranscript: q.source } });
    // Create vocab on the copy before timing; migration is tested separately.
    searchTranscripts({ query: "synthetic_initialisation_probe", order: "relevance" });
    for (const [i, q] of sample.entries()) {
      let start = performance.now();
      const before = baselinePage(db, q);
      beforeMs.push(performance.now() - start);
      start = performance.now();
      const page = after(q);
      afterMs.push(performance.now() - start);
      if (!before.total) zeroBefore++;
      if (!page.total) anyZeroAfter++;
      if (!page.strongTotal) zeroAfter++;
      if ((i + 1) % 100 === 0) console.error(`replayed ${i + 1} queries`);
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const uniquePairs = new Map<string, ReplayQuery>();
    for (const q of pairs.sort((a, b) => a.timestamp - b.timestamp)) {
      const key = q.query + "\0" + q.opened;
      if (!uniquePairs.has(key)) uniquePairs.set(key, q);
    }
    const clicks = seededSample([...uniquePairs.values()], Number(flag("pairs") ?? 300), 7);
    let recallBefore = 0, recallAfter = 0;
    for (const q of clicks) {
      if (baselinePage(db, q).paths.slice(0, 6).includes(q.opened!)) recallBefore++;
      if (after(q).items.some((i) => i.transcriptPath === q.opened || i.alsoIn?.transcriptPaths.includes(q.opened!))) recallAfter++;
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    const percentile = (v: number[], p: number) => [...v].sort((a, b) => a - b)[Math.ceil(v.length * p) - 1];
    const words: Record<string, number> = {};
    for (const q of sample) {
      const n = q.query.split(/\s+/u).length;
      const group = n >= 8 ? "8+" : n >= 5 ? "5-7" : n >= 3 ? "3-4" : String(n);
      words[group] = (words[group] ?? 0) + 1;
    }
    console.log(JSON.stringify({ sample: sample.length, words, distinctQueries: distinct.size, filesRead, filesUnavailable,
      clickedPairs: clicks.length, zeroBefore, zeroAfterStrong: zeroAfter, zeroAfterAny: anyZeroAfter,
      openedTop6Before: recallBefore, openedTop6After: recallAfter,
      beforeP50Ms: percentile(beforeMs, 0.5), beforeP95Ms: percentile(beforeMs, 0.95),
      afterP50Ms: percentile(afterMs, 0.5), afterP95Ms: percentile(afterMs, 0.95), afterMaxMs: Math.max(...afterMs),
    }, null, 2));
  } finally { db.close(); }
}

if (import.meta.main) {
  await runReplay(process.argv.slice(2));
}
