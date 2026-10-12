#!/usr/bin/env bun
/**
 * End-to-end profile of the global message search (#1429) on the synthetic
 * corpus `transcript-search-fixture.ts` writes: the same three queries on every
 * surface the operator reaches it through.
 *
 *   LLV_STATE_DIR=<scratch> bash scripts/gate-slot.sh bun scripts/transcript-search-bench.ts <fixtureDir> [--production] [--repeat 5] [--json <file>] [--skip-mcp] [--skip-ui]
 *
 * Refuses to run without an explicit LLV_STATE_DIR so the index build can never
 * touch the operator's live `transcript-search.sqlite`, and the MCP host it
 * spawns keeps its receipts in that same scratch directory.
 *
 * Surfaces, from the inside out:
 *   - library — `searchTranscripts` in this process: the SQLite work alone;
 *   - route   — the exported route handler called in-process: library plus
 *               title lookup and JSON serialisation;
 *   - http    — the same handler served by a loopback Bun.serve and fetched:
 *               what the browser and the MCP host actually wait for;
 *   - mcp     — the packaged stdio server (`bin/mcp-server.mjs`, the release
 *               bundle under Bun, as on the host) pointed at that loopback
 *               Viewer, driven through the MCP SDK client: receipts, control
 *               HTTP, redaction and result serialisation on top of http;
 *   - ui      — the real palette (`GlobalSearch`) mounted in happy-dom with
 *               `fetch` routed to the loopback Viewer: from the last keystroke
 *               to the first rendered result row, debounce included. `fast`
 *               types the query with 120 ms between keys so only the final
 *               query is requested; `slow` leaves 300 ms after every key so
 *               each pause fires its own request, which is what stacks queries
 *               on the Viewer's event loop.
 * `--production` serves the current production build on port 0 in a child,
 * recording search latency, a concurrent cheap route and event-loop delay.
 * Each cell is the median of `--repeat` runs. Measurements contain timings,
 * counts and invented probe words.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { monitorEventLoopDelay } from "node:perf_hooks";

import { appDirIn } from "../bin/appDir.mjs";
import { GET as searchRoute } from "@/app/api/search/transcripts/route";
import { replaceConversationCatalog } from "@/lib/scanner/conversationCatalog";
import { indexTranscriptSources, searchTranscripts, type TranscriptIndexSource, type TranscriptSpeaker } from "@/lib/search/transcriptSearch";
import { TRANSCRIPT_SEARCH_DEBOUNCE_MS } from "@/components/search/useTranscriptSearch";

import type { TranscriptFixtureManifest } from "./transcript-search-fixture";

interface Cell {
  surface: "library" | "route" | "http" | "mcp" | "ui-fast" | "ui-slow";
  query: string;
  speaker: string;
  order?: "newest" | "relevance";
  runs: number[];
  median: number;
  /** Requests the Viewer answered for the cell's runs (ui surfaces only). */
  requests?: number;
  total?: number;
}

function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(`--${name}`);
  return index >= 0 ? args[index + 1] : undefined;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function publishFixtureCatalog(root: string, manifest: TranscriptFixtureManifest): void {
  replaceConversationCatalog(manifest.files.map((file, index) => ({
    path: path.join(root, file.path),
    root: file.engine === "claude" ? "claude-projects" : "codex-sessions",
    name: path.basename(file.path),
    project: file.project,
    title: `Fixture conversation ${index + 1}`,
    firstPrompt: `Fixture conversation ${index + 1}`,
    engine: file.engine,
    kind: "session",
    fmt: file.engine,
    mtime: file.mtime,
    size: 0,
  })));
}

async function shutdownQueryWorker(): Promise<void> {
  const workerModule = path.resolve("src/lib/search/transcriptSearchWorker.ts");
  if (fs.existsSync(workerModule)) await (await import(workerModule)).shutdownTranscriptSearchWorker();
}

async function mcpCells(origin: string, directory: string): Promise<Cell[]> {
  const cells: Cell[] = [];
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
  const environment = Object.fromEntries(Object.entries(process.env)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  environment.LLV_STATE_DIR = directory;
  environment.LLV_VIEWER_CONTROL_URL = origin;
  delete environment.LLV_VIEWER_DEPLOY_TARGET;
  delete environment.LLV_SPAWN_CAPABILITY;
  delete environment.DELEGATUS_SPAWN_CAPABILITY;
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(process.cwd(), "bin", "mcp-server.mjs")],
    cwd: process.cwd(),
    env: environment,
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const client = new Client({ name: "transcript-search-bench", version: "1.0.0" });
  try {
    await client.connect(transport);
    /* The tool has no speaker argument: it always searches both sides. */
    for (const query of queries) for (const order of ["newest", "relevance"] as const) {
      const runs: number[] = [];
      let total = 0;
      for (let run = 0; run < repeat; run += 1) {
        const startedAt = performance.now();
        const result = await client.callTool({
          name: "search_transcripts",
          arguments: { clientRequestId: `bench-${Date.now()}-${run}-${Math.random().toString(36).slice(2)}`, query, order, limit: order === "relevance" ? 6 : 20 },
        });
        runs.push(performance.now() - startedAt);
        const structured = result.structuredContent as { ok?: boolean; total?: number; error?: string } | undefined;
        if (!structured?.ok) throw new Error(`search_transcripts failed: ${structured?.error ?? "no structured content"}`);
        total = structured.total ?? 0;
      }
      cells.push({ surface: "mcp", order, query, speaker: "all", runs, median: median(runs), total });
    }
  } finally {
    await client.close().catch(() => {});
  }
  return cells;
}

const args = process.argv.slice(2);
// A port-0 production server in a child keeps the load generator's timers off
// the thread being measured. Only the benchmark controls bypass Next.
if (args.includes("--serve-production")) {
  const { default: next } = await import("next");
  const app = next({ dev: false, hostname: "127.0.0.1" });
  await app.prepare();
  const fixtureRoot = args[args.indexOf("--serve-production") + 1];
  publishFixtureCatalog(fixtureRoot, JSON.parse(fs.readFileSync(path.join(fixtureRoot, "manifest.json"), "utf8")));
  const delay = monitorEventLoopDelay({ resolution: 1 });
  delay.enable();
  const handler = app.getRequestHandler();
  const server = http.createServer((request, response) => {
    if (request.url === "/__bench/reset") {
      delay.reset();
      response.end("ok");
    } else if (request.url === "/__bench/delay") {
      response.end(JSON.stringify({ maxMs: delay.max / 1e6 }));
    } else if (request.url === "/__bench/stop") {
      void (async () => {
        await shutdownQueryWorker();
        response.end("ok");
      })().catch(() => { response.statusCode = 500; response.end("worker shutdown failed"); });
    } else void handler(request, response);
  });
  server.listen(0, "127.0.0.1", () => {
    const address = server.address() as import("node:net").AddressInfo;
    console.log(`BENCH_READY http://127.0.0.1:${address.port}`);
  });
  await new Promise(() => {});
}
const fixtureDir = args.find((arg) => !arg.startsWith("--") && !args.includes(`--${arg}`) && !/^\d+$/.test(arg) && !arg.endsWith(".json"));
const stateDir = process.env.LLV_STATE_DIR;
const defaultStateDir = path.join(appDirIn(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")), "state");
if (!fixtureDir || !stateDir || path.resolve(stateDir) === defaultStateDir) {
  console.error("usage: LLV_STATE_DIR=<scratch> bun scripts/transcript-search-bench.ts <fixtureDir> [--repeat 5] [--json <file>] [--skip-mcp] [--skip-ui]");
  process.exit(2);
}
const repeat = Math.max(1, Number(flag(args, "repeat") ?? 5) || 5);
const jsonOut = flag(args, "json");
const root = path.resolve(fixtureDir);
const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8")) as TranscriptFixtureManifest;
const sources: TranscriptIndexSource[] = manifest.files.map((file) => {
  const absolute = path.join(root, file.path);
  const stat = fs.statSync(absolute);
  return { path: absolute, project: file.project, engine: file.engine, size: stat.size, mtimeMs: stat.mtimeMs };
});

const indexStartedAt = performance.now();
const indexed = await indexTranscriptSources(sources, { complete: true });
const indexMs = Math.round(performance.now() - indexStartedAt);
if (indexed.failures.length) throw new Error(`${indexed.failures.length} fixture transcript(s) failed to index`);
/* Titles come off the in-memory catalog in production; publish one of the
   same size so the route's per-page title lookup is part of the measurement. */
publishFixtureCatalog(root, manifest);

const queries = [manifest.probes.rare, manifest.probes.commonPair, manifest.probes.veryCommon];
const speakers: Array<TranscriptSpeaker | undefined> = ["user", undefined];
const cells: Cell[] = [];
const stats = searchTranscripts({ query: manifest.probes.rare }).stats;
console.log(`corpus: ${stats.conversationsIndexed} conversations / ${stats.messagesIndexed} messages; index build ${indexMs} ms (${indexed.filesRead} read, ${indexed.filesSkipped} unchanged)`);

if (args.includes("--production")) {
  // Serve as a release candidate: autonomous scanner/controllers would replace
  // the synthetic index with the empty inventory of this isolated home.
  fs.writeFileSync(path.join(stateDir, "viewer-release.json"), JSON.stringify({
    endpoint: "http://127.0.0.1:1", image: "fixture", container: "fixture", revision: "0".repeat(40),
  }));
  const environment: NodeJS.ProcessEnv = { ...process.env, NODE_ENV: "production", DELEGATUS_TELEMETRY: "0", DO_NOT_TRACK: "1", NEXT_TELEMETRY_DISABLED: "1",
    PORT: "0" };
  for (const name of ["LLV_CODEX_HOME", "LLV_CLAUDE_HOME", "LLV_RUNTIME_HOST_SOCKET", "LLV_VIEWER_DEPLOY_TARGET",
    "LLV_SPAWN_CAPABILITY", "DELEGATUS_SPAWN_CAPABILITY"]) delete environment[name];
  const child = Bun.spawn([process.execPath, import.meta.path, "--serve-production", root], {
    env: environment,
    stdout: "pipe", stderr: "inherit",
  });
  let stopServer: (() => Promise<void>) | undefined;
  try {
    let output = "";
    let readinessTimer: ReturnType<typeof setTimeout> | undefined;
    const origin = await Promise.race([
      (async () => {
        const reader = child.stdout.getReader();
        try {
          while (true) {
            const chunk = await reader.read();
            if (chunk.done) break;
            output += Buffer.from(chunk.value).toString();
            const match = /BENCH_READY (http:\/\/127\.0\.0\.1:\d+)/.exec(output);
            if (match) return match[1];
            if (output.length > 8192) output = output.slice(-8192);
          }
        } finally { reader.releaseLock(); }
        throw new Error("production benchmark server exited before readiness");
      })(),
      new Promise<never>((_, reject) => {
        readinessTimer = setTimeout(() => reject(new Error("production benchmark server readiness timed out")), 60_000);
      }),
    ]).finally(() => clearTimeout(readinessTimer));
    void child.stdout.pipeTo(new WritableStream({ write() {} })).catch(() => {});
    stopServer = async () => {
      const response = await fetch(`${origin}/__bench/stop`, { signal: AbortSignal.timeout(10_000) });
      await response.text();
      if (!response.ok) throw new Error("production search worker did not stop cleanly");
    };
    const measurements = [];
    const cheap = async () => {
      const start = performance.now();
      const response = await fetch(`${origin}/api/search/transcripts`);
      await response.text();
      if (response.status !== 400) throw new Error("cheap request did not reach the production handler");
      return performance.now() - start;
    };
    await cheap();
    const idle = [];
    for (let i = 0; i < repeat; i++) idle.push(await cheap());
    const coldAt = performance.now();
    const coldResponse = await fetch(url(origin, queries[0], "user"));
    if (!coldResponse.ok) throw new Error(`production cold search failed: ${coldResponse.status}`);
    const coldPage = await coldResponse.json();
    if (coldPage.stats.conversationsIndexed !== stats.conversationsIndexed || coldPage.stats.messagesIndexed !== stats.messagesIndexed) {
      throw new Error("production benchmark corpus changed during cold search");
    }
    const coldSearchMs = performance.now() - coldAt;
    for (const order of ["newest", "relevance"] as const) {
      for (const query of queries) for (const speaker of speakers) {
        const pathname = url(origin, query, speaker) + `&order=${order}`;
        await (await fetch(pathname)).json(); // warm the route and resident worker
        const searchMs = [], cheapMs = [], delayMs = [];
        let total = 0;
        for (let i = 0; i < repeat; i++) {
          await fetch(`${origin}/__bench/reset`);
          const start = performance.now();
          const search = fetch(pathname).then(async response => {
            if (!response.ok) throw new Error(`production search failed: ${response.status}`);
            const page = await response.json();
            if (page.stats.conversationsIndexed !== stats.conversationsIndexed || page.stats.messagesIndexed !== stats.messagesIndexed) {
              throw new Error("production benchmark corpus changed during measurement");
            }
            total = page.total;
            return performance.now() - start;
          });
          await Bun.sleep(5);
          cheapMs.push(await cheap());
          searchMs.push(await search);
          delayMs.push((await (await fetch(`${origin}/__bench/delay`)).json()).maxMs);
        }
        measurements.push({ order, query, speaker: speaker ?? "all", total, searchMs, cheapMs, delayMs,
          searchMedianMs: median(searchMs), cheapMedianMs: median(cheapMs), delayMedianMs: median(delayMs) });
      }
    }
    const result = { corpus: { conversations: stats.conversationsIndexed, messages: stats.messagesIndexed, seed: manifest.seed },
      cheapIdleMedianMs: median(idle), coldSearchMs, measurements, mcp: args.includes("--skip-mcp") ? [] : await mcpCells(origin, stateDir) };
    console.log(JSON.stringify(result, null, 2));
    if (jsonOut) fs.writeFileSync(jsonOut, JSON.stringify(result, null, 2) + "\n");
  } finally {
    try { await stopServer?.(); }
    finally {
      child.kill("SIGTERM");
      const killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
      try { await child.exited; } finally { clearTimeout(killTimer); }
    }
  }
  process.exit(0);
}

function url(origin: string, query: string, speaker: TranscriptSpeaker | undefined): string {
  const params = new URLSearchParams({ q: query, limit: "20" });
  if (speaker) params.set("speaker", speaker);
  return `${origin}/api/search/transcripts?${params}`;
}

let served = 0;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: (request) => {
    served += 1;
    return searchRoute(request);
  },
});
const origin = server.url.origin;

for (const query of queries) {
  for (const speaker of speakers) {
    const label = speaker ?? "all";
    const library: number[] = [];
    let total = 0;
    for (let run = 0; run < repeat; run += 1) {
      const startedAt = performance.now();
      total = searchTranscripts({ query, speaker, limit: 20 }).total;
      library.push(performance.now() - startedAt);
    }
    cells.push({ surface: "library", query, speaker: label, runs: library, median: median(library), total });
    const route: number[] = [];
    for (let run = 0; run < repeat; run += 1) {
      const startedAt = performance.now();
      await (await searchRoute(new Request(url("http://127.0.0.1", query, speaker)))).json();
      route.push(performance.now() - startedAt);
    }
    cells.push({ surface: "route", query, speaker: label, runs: route, median: median(route), total });
    const http: number[] = [];
    for (let run = 0; run < repeat; run += 1) {
      const startedAt = performance.now();
      await (await fetch(url(origin, query, speaker))).json();
      http.push(performance.now() - startedAt);
    }
    cells.push({ surface: "http", query, speaker: label, runs: http, median: median(http), total });
  }
}

for (const query of queries) {
  for (const speaker of speakers) {
    const runs: number[] = [];
    let page;
    for (let run = 0; run < repeat; run++) {
      const start = performance.now();
      page = searchTranscripts({ query, speaker, order: "relevance", limit: 6 });
      runs.push(performance.now() - start);
    }
    cells.push({ surface: "library", order: "relevance", query, speaker: speaker ?? "all", runs, median: median(runs), total: page!.total });
    if (query === manifest.probes.commonPair && median(runs) > 300) throw new Error("Relevance common-pair median exceeds 300 ms");
    if (Buffer.byteLength(JSON.stringify(page)) > 6144) throw new Error("Six-conversation relevance page exceeds 6 KB");
  }
}

// The second pass's costliest shape: an absent compound term whose parts are both common.
const compound = manifest.probes.commonPair.replace(" ", "_");
{
  const runs: number[] = [];
  let page;
  for (let run = 0; run < repeat; run++) {
    const start = performance.now();
    page = searchTranscripts({ query: compound, order: "relevance", limit: 6 });
    runs.push(performance.now() - start);
  }
  cells.push({ surface: "library", order: "relevance", query: compound, speaker: "all", runs, median: median(runs), total: page!.total });
  if (median(runs) > 300) throw new Error("Relevance compound-term median exceeds 300 ms");
}

if (!args.includes("--skip-mcp")) cells.push(...await mcpCells(origin, stateDir));

if (!args.includes("--skip-ui")) {
  const { Window } = await import("happy-dom");
  const dom = new Window({ url: "http://localhost/" });
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    location: dom.location,
    history: dom.history,
    localStorage: dom.localStorage,
    Node: dom.Node,
    HTMLElement: dom.HTMLElement,
    HTMLInputElement: dom.HTMLInputElement,
    Element: dom.Element,
    Event: dom.Event,
    KeyboardEvent: dom.KeyboardEvent,
    MouseEvent: dom.MouseEvent,
  });
  const realFetch = globalThis.fetch;
  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
    realFetch(new URL(String(input), origin), init)) as typeof fetch;
  const { createElement } = await import("react");
  const { createRoot } = await import("react-dom/client");
  const { GlobalSearch } = await import("@/components/search/GlobalSearch");
  const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
  const valueSetter = Object.getOwnPropertyDescriptor(dom.HTMLInputElement.prototype, "value")!.set!;
  for (const query of queries) {
    for (const speaker of speakers) {
      for (const typing of ["fast", "slow"] as const) {
        const gap = typing === "fast" ? 120 : 300;
        const runs: number[] = [];
        let requests = 0;
        for (let run = 0; run < repeat; run += 1) {
          const mountNode = dom.document.createElement("div");
          dom.document.body.append(mountNode);
          const host = mountNode as unknown as HTMLElement;
          const mounted = createRoot(host);
          mounted.render(createElement(GlobalSearch, { mobile: false, onClose: () => {}, onOpen: () => {} }));
          await sleep(20);
          if (!speaker) {
            host.querySelector<HTMLElement>('[data-search-scope="everything"]')!.dispatchEvent(new dom.MouseEvent("click", { bubbles: true, cancelable: true }) as unknown as Event);
            await sleep(20);
          }
          const input = host.querySelector<HTMLInputElement>("[data-search-input]")!;
          input.focus();
          const servedBefore = served;
          let lastKeyAt = 0;
          for (let length = 1; length <= query.length; length += 1) {
            valueSetter.call(input, query.slice(0, length));
            lastKeyAt = performance.now();
            input.dispatchEvent(new dom.Event("input", { bubbles: true }) as unknown as Event);
            input.dispatchEvent(new dom.KeyboardEvent("keydown", { key: query[length - 1]!, bubbles: true }) as unknown as Event);
            if (length < query.length) await sleep(gap);
          }
          const deadline = lastKeyAt + 60_000;
          let resultAt: number | null = null;
          while (performance.now() < deadline) {
            /* The first row that answers the FINAL query: a held (stale) list
               from an earlier pause does not count. */
            const list = host.querySelector("[data-search-stale]");
            if (!list && host.querySelector("[data-search-result]") && !host.querySelector("[data-search-updating]")) { resultAt = performance.now(); break; }
            await sleep(2);
          }
          if (resultAt === null) throw new Error(`palette showed no result for ${query} (${speaker ?? "all"}, ${typing}) within 60 s`);
          runs.push(resultAt - lastKeyAt);
          /* Let every request the pauses fired settle before the next run. */
          await sleep(TRANSCRIPT_SEARCH_DEBOUNCE_MS + 50);
          requests += served - servedBefore;
          mounted.unmount();
          host.remove();
        }
        cells.push({ surface: typing === "fast" ? "ui-fast" : "ui-slow", query, speaker: speaker ?? "all", runs, median: median(runs), requests: Math.round(requests / repeat) });
      }
    }
  }
}

server.stop(true);
await shutdownQueryWorker();

const label = (query: string) => query === manifest.probes.rare ? "rare word" : query === manifest.probes.commonPair ? "two common words"
  : query === compound ? "compound of two common words" : "one very common word";
console.log("\n| surface | query | speaker | matches | median ms | runs (ms) |");
console.log("| --- | --- | --- | --- | --- | --- |");
for (const cell of cells) {
  const extra = cell.requests !== undefined ? ` (${cell.requests} req/run)` : "";
  console.log(`| ${cell.surface}${cell.order ? ` (${cell.order})` : ""} | ${label(cell.query)} | ${cell.speaker} | ${cell.total ?? ""} | ${Math.round(cell.median)}${extra} | ${cell.runs.map((run) => Math.round(run)).join(" / ")} |`);
}
if (jsonOut) {
  fs.writeFileSync(jsonOut, JSON.stringify({
    corpus: { conversations: stats.conversationsIndexed, messages: stats.messagesIndexed, indexMs, seed: manifest.seed },
    debounceMs: TRANSCRIPT_SEARCH_DEBOUNCE_MS,
    cells: cells.map((cell) => ({ ...cell, query: label(cell.query), runs: cell.runs.map((run) => Math.round(run * 10) / 10), median: Math.round(cell.median * 10) / 10 })),
  }, null, 2) + "\n");
  console.log(`\nwrote ${jsonOut}`);
}
process.exit(0);
