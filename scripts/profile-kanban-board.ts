/**
 * Kanban board update-stall and scroll profile (issue #1546).
 *
 * Usage: bun scripts/profile-kanban-board.ts <source-root> <output-dir> [idle-seconds]
 *
 * Bundles the REAL board over `issue1695Evidence.fixture.tsx`, scaled to the
 * shape #1546 reported (hundreds of flows, files and tasks — all invented), and
 * serves it on an ephemeral loopback port. Every API and stream response
 * terminates in the fixture, so this measures the browser's own work: no live
 * state, no deployed server, no operator data.
 *
 * Two samples, written to `<output-dir>/results.json`:
 *
 * - `idle`  — the operator is not touching the board while data keeps arriving.
 *             Catalog updates are dispatched on a fixed cadence for the whole
 *             window; long tasks, frame intervals and a CPU profile are kept.
 * - `scroll`— 80 wheel events down the Assigned column with the data frozen.
 *             Sampled script time, React commits and frame intervals are kept.
 *
 * - `stream`  — (#2218) agents stream: every working conversation is hosted on a
 *             structured session and the driver pushes `delta` events down the
 *             runtime stream at a fixed rate, with the CPU throttled
 *             (`PROFILE_CPU`, default 4). Frames per second, long tasks and React
 *             commits per event are kept.
 *
 * Diagnostics, all opt-in so a timing run stays a timing run:
 * `PROFILE_RENDERS=1` names the components that re-rendered per event and the
 * props that changed on them; `PROFILE_TRACE=1` adds a browser trace (layout,
 * style, paint, compositing) of the stream window; `PROFILE_CSS` injects rules
 * after load to switch a suspect off and read what that gives back.
 * `PROFILE_WIDTH=390` measures the phone viewport. `PROFILE_LATENCY=1` adds
 * three streaming rename/move rounds after a 40 s warm stream (override with
 * `PROFILE_WARM_SECONDS`) and one quiet round. `PROFILE_FIXTURE` lets a pair
 * of source trees use the same fixture and load while keeping their own code.
 *
 * Both halves run against whatever source tree they are pointed at, so a
 * before/after pair is one checkout apart and nothing else.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const repo = path.resolve(process.argv[2] ?? ".");
const out = path.resolve(process.argv[3] ?? ".artifacts/performance/kanban");
const idleSeconds = Number(process.argv[4] ?? 35);
/* How many historical builders (each with its review lineage card) the corpus adds: the default is the 357-card board of #1546; a board is 17 cards plus `HISTORY` builders plus one finished task for each of the first 60, so `PROFILE_HISTORY=19` is a 55-card board and `PROFILE_HISTORY=40` the 97-card board that stands for the 96-card project of #2218 (cards are counted in `corpus.cards`). */
const HISTORY = Number(process.env.PROFILE_HISTORY ?? 280);
fs.mkdirSync(out, { recursive: true });

/* The fixture, scaled up. The added corpus is entirely invented: numbered
   historical builders, their review rounds and their finished tasks. */
// Point both trees at the same fixture when comparing against a branch whose
// fixture predates the streaming case; component imports still resolve in repo.
let fixture = fs.readFileSync(process.env.PROFILE_FIXTURE ?? path.join(repo, "src/components/kanban/issue1695Evidence.fixture.tsx"), "utf8");
fixture = fixture.replace('const PIPELINES = SCENARIO === "pipelines" || STAGES;', "const PIPELINES = true;");
fixture = fixture.replace("let revision = 1;", `
for (let i = 0; i < ${HISTORY}; i++) {
  const builder = add(conversation('history-builder-' + i, 'Historical work ' + i));
  const reviewers = [0, 1].map(j => add(conversation('history-review-' + i + '-' + j, 'Historical review ' + i)));
  const flow = reviewFlow('history-flow-' + i, builder, reviewers[1], ['REQUEST_CHANGES', 'REQUEST_CHANGES', 'REQUEST_CHANGES', 'APPROVE'], 100000);
  flow.state = 'closed';
  flows.push(flow);
}
let revision = 1;`);
fixture = fixture.replace("if (EDITING) {\n  const at", `
for (let i = 0; i < 600; i++) tasks.push(task('history-task-' + i, 'done', 'Historical task ' + i, 'Synthetic acceptance notes. '.repeat(12), 100000, i < ${Math.min(60, HISTORY)} ? [files.find(f => f.name === 'history-builder-' + i + '.jsonl')] : [], i < ${Math.min(60, HISTORY)} ? {} : { board: 'hidden' }));
if (EDITING) {\n  const at`);
/* The driver's handles: corpus size, one catalog update, and React commits. */
fixture = fixture.replace("Object.assign(window, { evidence });", `Object.assign(window, { evidence,
  profileCorpus: { files: files.length, flows: flows.length, tasks: tasks.length, liveIds: files.filter(f => f.activity === 'live').map(f => f.conversationId) },
  profileUpdate: () => { files[0] = { ...files[0], mtime: files[0].mtime + 1, size: files[0].size + 1 }; window.dispatchEvent(new Event('llv:files-changed')); },
});`);

/* The bundle entry lives inside the tree being measured: `react` has to
   resolve to the SAME copy for the fixture and for the components it imports,
   or the board mounts against a null dispatcher. */
const stage = path.join(repo, ".artifacts/profile-kanban");
fs.mkdirSync(stage, { recursive: true });
const fixturePath = path.join(stage, "fixture.tsx");
fs.writeFileSync(fixturePath, fixture);
/* The evidence builder stubs server actions the way Next does for the client
   bundle (#2009); a plain browser build fails on the first Node import. */
const build = Bun.spawnSync([
  process.execPath, path.join(repo, "src/components/kanban/buildEvidenceFixture.ts"), fixturePath, `${stage}/bundle`,
], { cwd: repo, stdout: "pipe", stderr: "pipe" });
if (build.exitCode) throw new Error(build.stderr.toString() + build.stdout.toString());

const cssPath = path.join(repo, "src/app/globals.css");
const css = await postcss([tailwind()]).process(fs.readFileSync(cssPath, "utf8"), { from: cssPath });
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
  const pathname = new URL(request.url).pathname;
  if (pathname === "/app.js") return new Response(Bun.file(path.join(stage, "bundle/fixture.js")), { headers: { "content-type": "text/javascript" } });
  if (pathname === "/style.css") return new Response(css.css, { headers: { "content-type": "text/css" } });
  return new Response('<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/style.css"></head><body><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div><script type="module" src="/app.js"></script></body></html>', { headers: { "content-type": "text/html" } });
} });

interface Sampled { longTasks: { at: number; ms: number }[]; frames: number[] }

const summarize = (sample: Sampled, windowMs: number) => ({
  windowMs: Math.round(windowMs),
  longTasks: sample.longTasks.length,
  longTaskTotalMs: Math.round(sample.longTasks.reduce((a, b) => a + b.ms, 0)),
  longTaskMaxMs: Math.round(Math.max(0, ...sample.longTasks.map((entry) => entry.ms))),
  frames: sample.frames.length,
  framesOver25: sample.frames.filter((ms) => ms > 25).length,
  frameMaxMs: Math.round(Math.max(0, ...sample.frames)),
  frameP95Ms: Number(percentile(sample.frames, 95).toFixed(1)),
});

const rounded = (value: { scriptMs: number; jsMs: number }) => ({ scriptMs: Math.round(value.scriptMs), jsMs: Math.round(value.jsMs) });

function percentile(values: readonly number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

interface CpuProfile { nodes: { id: number; callFrame: { functionName: string } }[]; samples: number[]; timeDeltas: number[] }

/** Sampled work that is not `(idle)`: `scriptMs` is everything the main thread
    did, `jsMs` drops `(program)` — V8's own parse/compile/compositor bookkeeping,
    which moves independently of the code under test. */
function sampledMs(profile: CpuProfile): { scriptMs: number; jsMs: number } {
  const named = (name: string) => new Set(profile.nodes.filter((node) => node.callFrame.functionName === name).map((node) => node.id));
  const idle = named("(idle)");
  const program = named("(program)");
  let script = 0;
  let js = 0;
  for (const [index, id] of profile.samples.entries()) {
    if (idle.has(id)) continue;
    const ms = (profile.timeDeltas[index] ?? 0) / 1000;
    script += ms;
    if (!program.has(id)) js += ms;
  }
  return { scriptMs: script, jsMs: js };
}

/** Self time of one function in a sampled profile — the attribution #1546 asked
    for, reported by name so a reader can check it against the source. */
function selfMs(profile: CpuProfile, functionName: string): number {
  const ids = new Set(profile.nodes.filter((node) => node.callFrame.functionName === functionName).map((node) => node.id));
  let total = 0;
  for (const [index, id] of profile.samples.entries()) if (ids.has(id)) total += (profile.timeDeltas[index] ?? 0) / 1000;
  return total;
}

const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], executablePath: process.env.CHROME_BIN ?? "/usr/bin/google-chrome-stable" });
const results: Record<string, unknown> = {};
try {
  const width = Number(process.env.PROFILE_WIDTH ?? 1440);
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 900 }, deviceScaleFactor: 1 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.addInitScript(() => {
    const w = window as unknown as Record<string, unknown>;
    const sample = { longTasks: [] as unknown[], frames: [] as number[], commits: 0, lastCommitAt: 0, recording: false };
    w.profileSample = sample;
    if (new URLSearchParams(location.search).get("renders") === "1") { w.profileRenders = {}; w.profileCauses = {}; w.profileCardIds = {}; }
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) if (sample.recording) sample.longTasks.push({ at: entry.startTime, ms: entry.duration }); }).observe({ type: "longtask", buffered: true });
    let previous = 0;
    const tick = (now: number) => { if (sample.recording && previous) sample.frames.push(now - previous); previous = now; requestAnimationFrame(tick); };
    requestAnimationFrame(tick);
    /* React publishes every commit through the devtools hook; a board render
       is always one of these, so counting them never undercounts. */
    (w as { __REACT_DEVTOOLS_GLOBAL_HOOK__?: unknown }).__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
      renderers: new Map(), supportsFiber: true, inject: () => 1,
      onCommitFiberRoot: (_id: unknown, root: { current: unknown }) => {
        sample.lastCommitAt = performance.now();
        if (!sample.recording) return;
        sample.commits++;
        if (!w.profileRenders) return;
        /* PROFILE_RENDERS=1: which components did work in this commit. Walking
           the tree costs time, so a counting run is never a timing run. */
        const renders = w.profileRenders as Record<string, number>;
        const causes = w.profileCauses as Record<string, Record<string, number>>;
        type Fiber = { child: Fiber | null; sibling: Fiber | null; flags: number; type: unknown; alternate: Fiber | null; memoizedProps: Record<string, unknown> | null };
        /* A fiber that bailed out shares its child with its alternate and keeps
           the flags of its last render, so only a rebuilt child list is walked
           (the rule React DevTools uses), and a mount is not a re-render. */
        const walk = (fiber: Fiber | null, parent = "") => {
          for (let f = fiber; f; f = f.sibling) {
            const previous = f.alternate;
            const type = f.type as { displayName?: string; name?: string; render?: { name?: string }; type?: { name?: string } } | string | null;
            const own = type && typeof type !== "string" ? (type.displayName ?? type.name ?? type.render?.name ?? type.type?.name ?? "") : "";
            if (previous && (f.flags & 1) && type && typeof type !== "string") {
              const name = own || "anonymous";
              renders[name] = (renders[name] ?? 0) + 1;
              /* The input that changed: the props that differ, or none (the
                 component's own state, a context or a store subscription). */
              const was = previous.memoizedProps ?? {};
              const is = f.memoizedProps ?? {};
              const changed = Object.keys({ ...was, ...is }).filter((key) => !Object.is(was[key], is[key]));
              const bucket = (causes[name] ??= {});
              for (const key of changed.length ? changed : ["(own state, context or store)"]) bucket[key] = (bucket[key] ?? 0) + 1;
              if (name === "KanbanCard2") {
                bucket[`via ${parent}`] = (bucket[`via ${parent}`] ?? 0) + 1;
                const id = (is.card as { id?: string } | undefined)?.id;
                const ids = w.profileCardIds as Record<string, number>;
                if (id) ids[id] = (ids[id] ?? 0) + 1;
              }
            }
            if (f.child !== (previous?.child ?? null)) walk(f.child, own || parent);
          }
        };
        walk((root.current as Fiber).child);
      },
      onCommitFiberUnmount: () => {}, onPostCommitFiberRoot: () => {},
    };
  });
  await page.goto(`http://127.0.0.1:${server.port}/?scenario=pipelines&streaming=1${process.env.PROFILE_RENDERS ? "&renders=1" : ""}`);
  try {
    await page.waitForSelector("[data-kanban-board] .card[data-id]", { state: "attached", timeout: 60_000 });
  } catch (error) {
    throw new Error(`the board never rendered a card: ${pageErrors.join(" | ") || "no page error"}`, { cause: error });
  }
  /* PROFILE_CSS: rules injected after load, to switch a suspect off and see what the trace gives back. */
  if (process.env.PROFILE_CSS) await page.addStyleTag({ content: process.env.PROFILE_CSS });
  await page.waitForTimeout(3_000);
  const corpus = await page.evaluate(() => ({
    ...(window as unknown as { profileCorpus: unknown }).profileCorpus as object,
    cards: document.querySelectorAll("[data-kanban-board] .card[data-id]").length,
    liveGlyphs: [...document.querySelectorAll('.mglyph[data-live="1"]')].map((glyph) => (glyph as HTMLElement).dataset.glyph).join(","),
    animations: document.getAnimations().length,
    dom: document.querySelectorAll("*").length,
  }));

  /* The components that re-rendered since the last read, per event, with the
     props that changed; absent unless PROFILE_RENDERS is set. */
  const readRenders = async (events: number) => {
    const tallies = await page.evaluate(() => {
      const w = window as unknown as { profileRenders?: Record<string, number>; profileCauses?: Record<string, Record<string, number>>; profileCardIds: Record<string, number> };
      if (!w.profileRenders) return null;
      const read = { renders: { ...w.profileRenders }, causes: JSON.parse(JSON.stringify(w.profileCauses)) as Record<string, Record<string, number>>, cards: { ...w.profileCardIds } };
      for (const key of Object.keys(w.profileRenders)) delete w.profileRenders[key];
      for (const key of Object.keys(w.profileCauses!)) delete w.profileCauses![key];
      for (const key of Object.keys(w.profileCardIds)) delete w.profileCardIds[key];
      return read;
    });
    if (!tallies) return {};
    const per = (count: number) => Number((count / events).toFixed(2));
    const named = (process.env.PROFILE_CAUSE_NAMES ?? "").split(",");
    return {
      cardsRendered: Object.fromEntries(Object.entries(tallies.cards).sort((a, b) => b[1] - a[1]).slice(0, 12)),
      rendersPerEvent: Object.fromEntries(Object.entries(tallies.renders).sort((a, b) => b[1] - a[1]).slice(0, Number(process.env.PROFILE_RENDER_ROWS ?? 40)).map(([name, count]) => [name, per(count)])),
      renderCauses: Object.fromEntries(Object.entries(tallies.causes).filter(([name]) => (tallies.renders[name] ?? 0) / events >= 0.5 || named.includes(name)).map(([name, keys]) => [name, Object.fromEntries(Object.entries(keys).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([key, count]) => [key, per(count)]))])),
    };
  };

  const start = () => page.evaluate(() => {
    const s = (window as unknown as { profileSample: { longTasks: unknown[]; frames: number[]; commits: number; recording: boolean; at?: number } }).profileSample;
    s.longTasks.length = 0; s.frames.length = 0; s.commits = 0; s.at = performance.now(); s.recording = true;
  });
  const stop = () => page.evaluate(() => {
    const s = (window as unknown as { profileSample: { longTasks: unknown[]; frames: number[]; commits: number; recording: boolean; at: number } }).profileSample;
    s.recording = false;
    return { longTasks: s.longTasks as { at: number; ms: number }[], frames: s.frames, commits: s.commits, windowMs: performance.now() - s.at };
  });

  /* ── idle: no input, data still arriving ───────────────────────────── */
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  await start();
  await page.evaluate(() => { (window as unknown as { profileTimer: number }).profileTimer = window.setInterval(() => (window as unknown as { profileUpdate: () => void }).profileUpdate(), 500); });
  await page.waitForTimeout(idleSeconds * 1_000);
  await page.evaluate(() => window.clearInterval((window as unknown as { profileTimer: number }).profileTimer));
  const idle = await stop();
  const idleRenders = await readRenders(Math.max(1, Math.round(idle.windowMs / 500)));
  const idleProfile = (await cdp.send("Profiler.stop")).profile;
  fs.writeFileSync(path.join(out, "idle-cpu.json"), JSON.stringify(idleProfile));
  results.idle = {
    ...summarize(idle, idle.windowMs), commits: idle.commits,
    ...rounded(sampledMs(idleProfile as never)),
    /* The grouping scan #1546 measured, named. */
    flowMembershipSelfMs: Math.round(selfMs(idleProfile as never, "flowMembership")),
    getBoundingClientRectSelfMs: Math.round(selfMs(idleProfile as never, "getBoundingClientRect")),
    ...idleRenders,
  };

  /* ── stream: agents streaming, the CPU throttled ───────────────────── */
  const cpuRate = Number(process.env.PROFILE_CPU ?? 4);
  const streamSeconds = Number(process.env.PROFILE_STREAM_SECONDS ?? 10);
  const eventsPerSecond = Number(process.env.PROFILE_EVENTS_PER_SECOND ?? 40);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
  await page.waitForTimeout(500);
  await cdp.send("Profiler.start");
  /* PROFILE_TRACE=1: a browser trace of the same window. `(program)` in the CPU
     profile is style, layout, paint and compositing; only a trace names them. */
  /* Playwright types a CDP session's events narrowly; the tracing ones are real. */
  const events = cdp as unknown as { on(event: string, handler: (params: never) => void): void; once(event: string, handler: (params: never) => void): void };
  const traceEvents: Array<{ name: string; ph: string; dur?: number; ts: number; tid: number; args?: unknown }> = [];
  if (process.env.PROFILE_TRACE) {
    events.on("Tracing.dataCollected", (chunk: { value: typeof traceEvents }) => traceEvents.push(...chunk.value));
    await cdp.send("Tracing.start", { categories: "devtools.timeline,disabled-by-default-devtools.timeline,blink.user_timing", transferMode: "ReportEvents" });
  }
  await start();
  const sent = await page.evaluate(async ({ seconds, rate }) => {
    const w = window as unknown as { profileCorpus: { liveIds: string[] }; runtimeEmit: (envelope: unknown) => void };
    const ids = w.profileCorpus.liveIds;
    const heads = new Map<string, number>(ids.map((id) => [id, 1]));
    let seq = 1_000;
    let count = 0;
    const begin = performance.now();
    /* One event per tick, round-robin over the streaming sessions, paced to the wall clock. */
    while (performance.now() - begin < seconds * 1_000) {
      const due = Math.floor(((performance.now() - begin) / 1_000) * rate);
      while (count < due) {
        const id = ids[count % ids.length]!;
        const revision = heads.get(id)! + 1;
        heads.set(id, revision);
        seq += 1;
        w.runtimeEmit({
          schemaVersion: 1, seq, eventId: `profile-${seq}`, scope: { type: "session", id }, revision, kind: "delta",
          occurredAt: new Date().toISOString(),
          payload: { conversationId: id, turnId: "turn-1", text: `streamed fragment ${count} of the reply, a sentence long enough to count `.repeat(2) },
        });
        count += 1;
      }
      await new Promise((resolve) => setTimeout(resolve, 4));
    }
    return count;
  }, { seconds: streamSeconds, rate: eventsPerSecond });
  const streamed = await stop();
  let trace: Record<string, { count: number; ms: number; maxMs: number }> | null = null;
  let layoutObjects: { layouts: number; meanDirty: number; meanTotal: number } | null = null;
  if (process.env.PROFILE_TRACE) {
    const done = new Promise<void>((resolve) => events.once("Tracing.tracingComplete", () => resolve()));
    await cdp.send("Tracing.end");
    await done;
    /* A Layout event says how many of the tree's objects it had to lay out. */
    const layouts = traceEvents.filter((event) => event.name === "Layout" && event.ph === "X").map((event) => (event.args as { beginData?: { dirtyObjects?: number; totalObjects?: number } } | undefined)?.beginData).filter(Boolean) as Array<{ dirtyObjects?: number; totalObjects?: number }>;
    layoutObjects = layouts.length ? { layouts: layouts.length, meanDirty: Math.round(layouts.reduce((sum, row) => sum + (row.dirtyObjects ?? 0), 0) / layouts.length), meanTotal: Math.round(layouts.reduce((sum, row) => sum + (row.totalObjects ?? 0), 0) / layouts.length) } : null;
    trace = {};
    for (const event of traceEvents) {
      if (event.ph !== "X" || !event.dur) continue;
      const row = (trace[event.name] ??= { count: 0, ms: 0, maxMs: 0 });
      row.count++;
      row.ms += event.dur / 1000;
      row.maxMs = Math.max(row.maxMs, event.dur / 1000);
    }
    fs.writeFileSync(path.join(out, "stream-trace.json"), JSON.stringify({ traceEvents }));
    trace = Object.fromEntries(Object.entries(trace).filter(([, row]) => row.ms >= 20).sort((a, b) => b[1].ms - a[1].ms).slice(0, 30).map(([name, row]) => [name, { count: row.count, ms: Math.round(row.ms), maxMs: Math.round(row.maxMs) }]));
  }
  const streamRenders = await readRenders(Math.max(1, sent));
  const streamProfile = (await cdp.send("Profiler.stop")).profile;
  fs.writeFileSync(path.join(out, "stream-cpu.json"), JSON.stringify(streamProfile));
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  results.stream = {
    cpuRate, events: sent, eventsPerSecond,
    ...summarize(streamed, streamed.windowMs), commits: streamed.commits,
    commitsPerEvent: Number((streamed.commits / Math.max(1, sent)).toFixed(2)),
    fps: Number((streamed.frames.length / (streamed.windowMs / 1_000)).toFixed(1)),
    ...rounded(sampledMs(streamProfile as never)),
    getBoundingClientRectSelfMs: Math.round(selfMs(streamProfile as never, "getBoundingClientRect")),
    ...(trace ? { trace, layoutObjects } : {}),
    ...streamRenders,
  };

  /* ── still: the same window with no input, so the commits and the script
     time a GESTURE is answerable for are what it costs above this. ──────── */
  await cdp.send("Profiler.start");
  await start();
  await page.waitForTimeout(2_700);
  const still = await stop();
  const stillProfile = (await cdp.send("Profiler.stop")).profile;
  results.still = { ...summarize(still, still.windowMs), commits: still.commits, ...rounded(sampledMs(stillProfile as never)) };

  /* ── scroll: 80 wheel events, data frozen ──────────────────────────── */
  const box = await page.locator('.column[data-status="assigned"] .col-body').first().boundingBox();
  if (!box) throw new Error("the Assigned column has no scroll box");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.waitForTimeout(500);
  await cdp.send("Profiler.start");
  await start();
  for (let i = 0; i < 80; i++) {
    await page.mouse.wheel(0, 60);
    await page.waitForTimeout(16);
  }
  const scroll = await stop();
  const scrollProfile = (await cdp.send("Profiler.stop")).profile;
  fs.writeFileSync(path.join(out, "scroll-cpu.json"), JSON.stringify(scrollProfile));
  /* Presence after the gesture: what the board reports must be what is on
     screen, whatever schedule the measurement runs on. */
  await page.waitForTimeout(1_500);
  const presence = await page.evaluate(() => {
    const posts = (window as unknown as { evidence: { presence: Array<{ visiblePaths: string[] }> } }).evidence.presence;
    const last = posts[posts.length - 1] ?? null;
    const tiles = [...document.querySelectorAll<HTMLElement>("[data-kanban-board] .tile[data-member]")].map((tile) => {
      const card = tile.closest<HTMLElement>(".card")!;
      const body = card.closest<HTMLElement>(".col-body")!.getBoundingClientRect();
      const rect = card.getBoundingClientRect();
      const onScreen = rect.bottom > body.top && rect.top < body.bottom && getComputedStyle(card.closest(".column")!).display !== "none";
      return { path: tile.dataset.member!, onScreen, reported: Boolean(last?.visiblePaths.includes(tile.dataset.member!)) };
    });
    return { posts: posts.length, tiles: tiles.length, mismatched: tiles.filter((tile) => tile.onScreen !== tile.reported) };
  });
  results.scroll = {
    ...summarize(scroll, scroll.windowMs), commits: scroll.commits,
    ...rounded(sampledMs(scrollProfile as never)),
    getBoundingClientRectSelfMs: Math.round(selfMs(scrollProfile as never, "getBoundingClientRect")),
    presence,
  };
  /* ── switch (#2218): to a board with no cards and back to the full one, the
     CPU throttled. `paintMs` is the first frame that shows a card, `settleMs`
     the last React commit before the board has been quiet for 400 ms. ───── */
  await page.mouse.move(2, 2);
  const switches: Array<{ paintMs: number; settleMs: number; cards: number; longTasks: number; longTaskMaxMs: number }> = [];
  for (let round = 0; round < Number(process.env.PROFILE_SWITCHES ?? 3); round++) {
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
    await page.evaluate(() => { location.hash = "#p=quiet-project"; });
    await page.waitForFunction(() => document.querySelectorAll("[data-kanban-board] .card[data-id]").length === 0, null, { timeout: 30_000 });
    await page.waitForTimeout(1_500);
    await cdp.send("Emulation.setCPUThrottlingRate", { rate: cpuRate });
    await start();
    const switched = await page.evaluate(async () => {
      const sample = (window as unknown as { profileSample: { lastCommitAt: number } }).profileSample;
      const cards = () => document.querySelectorAll("[data-kanban-board] .card[data-id]").length;
      const begin = performance.now();
      location.hash = "#p=atlas";
      let paintMs = -1;
      let last = begin;
      let count = 0;
      for (;;) {
        await new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
        const now = performance.now();
        if (paintMs < 0 && cards() > 0) paintMs = now - begin;
        if (cards() !== count) { count = cards(); last = now; }
        if (paintMs >= 0 && now - Math.max(last, sample.lastCommitAt) > 400) return { paintMs, settleMs: Math.max(last, sample.lastCommitAt) - begin, cards: count };
        if (now - begin > 30_000) return { paintMs, settleMs: now - begin, cards: count };
      }
    });
    const quiet = await stop();
    switches.push({ paintMs: Math.round(switched.paintMs), settleMs: Math.round(switched.settleMs), cards: switched.cards, longTasks: quiet.longTasks.length, longTaskMaxMs: Math.round(Math.max(0, ...quiet.longTasks.map((entry) => entry.ms))) });
  }
  // Optional freshness replay of the catalog edits found in the sustained
  // stream UI check. Keep this in the shared driver, with the same real board.
  if (process.env.PROFILE_LATENCY) {
    await page.screenshot({ path: path.join(out, "before-edits.png") });
    const latency = await page.evaluate(async ({ rate, warmSeconds }) => {
      const w = window as unknown as {
        profileCorpus: { liveIds: string[] };
        runtimeEmit: (envelope: unknown) => void;
        evidence: { storedTask: (id: string) => { status: string }; agentWritesTitle: (id: string, title: string) => void; setTaskStatus: (id: string, status: string) => void };
      };
      const ids = w.profileCorpus.liveIds;
      // Continue above the earlier timing sample's event/revision sequence.
      const heads = new Map(ids.map((id) => [id, 100_000]));
      let seq = 100_000;
      const emit = (count: number) => {
        const id = ids[count % ids.length]!;
        const revision = heads.get(id)! + 1;
        heads.set(id, revision);
        seq += 1;
        w.runtimeEmit({ schemaVersion: 1, seq, eventId: `latency-${seq}`, scope: { type: "session", id }, revision, kind: "delta", occurredAt: new Date().toISOString(),
          payload: { conversationId: id, turnId: "turn-1", text: `streamed fragment ${count} of the reply, a sentence long enough to count `.repeat(2) } });
      };
      const warmAt = performance.now();
      let warmCount = 0;
      while (performance.now() - warmAt < warmSeconds * 1000) {
        const due = Math.floor((performance.now() - warmAt) / 1000 * rate);
        while (warmCount < due) emit(warmCount++);
        await new Promise((resolve) => setTimeout(resolve, 4));
      }
      const rounds = [];
      for (const [streaming, round] of [[true, 1], [false, 2], [true, 3], [true, 4]] as const) {
        const begin = performance.now();
        const title = `Fresh title ${round}`;
        const status = w.evidence.storedTask("t-pending").status === "blocked" ? "inbox" : "blocked";
        let sentAt = -1, renameMs = -1, moveMs = -1, count = 0;
        while (performance.now() - begin < 9000 && (renameMs < 0 || moveMs < 0 || performance.now() - begin < 1500)) {
          const at = performance.now() - begin;
          if (sentAt < 0 && at >= 1000) {
            sentAt = at;
            w.evidence.agentWritesTitle("t-export", title);
            w.evidence.setTaskStatus("t-pending", status);
          }
          if (sentAt >= 0) {
            if (renameMs < 0 && document.querySelector('.card[data-id="task:t-export"] .title')?.textContent?.includes(title)) renameMs = at - sentAt;
            if (moveMs < 0 && document.querySelector('.card[data-id="task:t-pending"]')?.closest<HTMLElement>(".column")?.dataset.status === status) moveMs = at - sentAt;
          }
          if (streaming) {
            const due = Math.floor(at / 1000 * rate);
            while (count < due) emit(count++);
          }
          await new Promise((resolve) => setTimeout(resolve, 4));
        }
        rounds.push({ streaming, renameMs: Math.round(renameMs), moveMs: Math.round(moveMs), events: count });
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
      return { warmSeconds, rounds };
    }, { rate: eventsPerSecond, warmSeconds: Number(process.env.PROFILE_WARM_SECONDS ?? 40) });
    results.latency = latency;
    for (const [status, id, frame] of [["assigned", "t-export", "rename-painted.png"], ["inbox", "t-pending", "move-painted.png"]] as const) {
      const tab = page.locator(`.tabs-nav [data-tab="${status}"]`).first();
      if (await tab.count()) await tab.click();
      await page.locator(`.card[data-id="task:${id}"]`).scrollIntoViewIfNeeded();
      await page.screenshot({ path: path.join(out, frame) });
    }
    await page.screenshot({ path: path.join(out, "after-edits.png") });
  }
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });
  results.switch = { cpuRate, switches, medianPaintMs: switches.map((row) => row.paintMs).sort((a, b) => a - b)[Math.floor(switches.length / 2)] };
  results.corpus = corpus;
  results.pageErrors = pageErrors;
  fs.writeFileSync(path.join(out, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results, null, 2));
} finally {
  await browser.close();
  server.stop(true);
}
