/**
 * The real-browser profiling harness: one seeded home, one server, one raw-CDP
 * client, one in-page measurement probe — shared by every profile script that
 * needs real milliseconds out of a real Chrome.
 *
 * It was extracted from `profile-switching.ts` (#1432) when the reopen profile
 * (#1821) needed exactly the same boot, the same probe and the same table.
 * Anything scenario-specific — which conversations are seeded, which gestures
 * are driven, which milestones are recorded — stays in the calling script.
 *
 * Nothing here names a person, an account or a machine: the home it seeds is
 * a throwaway under the temp root, which is also what keeps the operator's own
 * state directory out of the run (see `stateOwnership.ts`).
 */
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export const DEFAULT_CHROME = process.env.LLV_PROFILE_CHROME ?? "/usr/bin/google-chrome-stable";

/* ── command line ───────────────────────────────────────────────────────── */

/** `--flag value` and bare `--flag` (value "1"), in the order they appear. */
export function parseArgs(argv: readonly string[] = process.argv): Map<string, string> {
  const args = new Map<string, string>();
  for (let index = 2; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) continue;
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      args.set(arg.slice(2), next);
      index += 1;
    } else {
      args.set(arg.slice(2), "1");
    }
  }
  return args;
}

/* ── throwaway home ─────────────────────────────────────────────────────── */

/**
 * The environment a seeded-home server runs under: every root a Viewer, a
 * scanner or an agent CLI could reach is redirected into `root`, so the run
 * cannot see — or write — the operator's own home, config or state.
 */
export function seededEnvironment(root: string, options: { nodeEnv?: "development" | "production" } = {}): NodeJS.ProcessEnv {
  const home = path.join(root, "home");
  const uid = process.getuid?.() ?? 1000;
  const tmp = path.join(root, "tmp");
  const config = path.join(home, ".config");
  for (const dir of [home, tmp, path.join(tmp, `claude-${uid}`), path.join(root, "tmux"), path.join(root, "cache"), path.join(root, "runtime"), config, path.join(config, "agent-log-viewer", "state")]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.chmodSync(path.join(root, "runtime"), 0o700);
  return {
    NODE_ENV: options.nodeEnv ?? "development",
    PATH: process.env.PATH,
    HOME: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    TMUX_TMPDIR: path.join(root, "tmux"),
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_RUNTIME_DIR: path.join(root, "runtime"),
    LLV_STATE_DIR: path.join(config, "agent-log-viewer", "state"),
    LLV_CLAUDE_HOME: path.join(home, ".claude"),
    LLV_CODEX_HOME: path.join(home, ".codex"),
    LLV_ACCOUNT_CONTROLLER_DISABLED: "1",
    LLV_REAPER_ENABLED: "0",
    NEXT_TELEMETRY_DISABLED: "1",
    TZ: "UTC",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    LOGNAME: "profile", USER: "profile",
    SHELL: "/bin/sh",
  };
}

/* ── processes ──────────────────────────────────────────────────────────── */

export function outputLines(child: ChildProcess): () => string {
  const lines: string[] = [];
  const push = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) if (line.trim()) lines.push(line);
    if (lines.length > 400) lines.splice(0, lines.length - 400);
  };
  child.stdout?.on("data", push);
  child.stderr?.on("data", push);
  return () => lines.join("\n");
}

/** Stop a child this process started, by its own handle. */
export async function stop(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGTERM");
  await Promise.race([exited, Bun.sleep(5_000)]);
  if (child.exitCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}

export async function waitForServer(url: string, child: ChildProcess, logs: () => string, timeoutMs = 240_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited early\n${logs()}`);
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) return;
    } catch {
      /* not up yet */
    }
    await Bun.sleep(500);
  }
  throw new Error(`server did not answer within ${timeoutMs} ms\n${logs()}`);
}

export function launchChrome(options: { cdpPort: number; userDataDir: string; home: string; chrome?: string }): ChildProcess {
  return spawn(options.chrome ?? DEFAULT_CHROME, [
    "--headless=new",
    `--remote-debugging-port=${options.cdpPort}`,
    `--user-data-dir=${options.userDataDir}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-gpu",
    "--hide-scrollbars",
    "--window-size=1280,800",
    /* A profile whose milestone is a PAINTED frame cannot run on a renderer
       Chrome has decided is in the background: animation frames are throttled
       to a crawl there and every number becomes the throttle's. */
    "--disable-background-timer-throttling",
    "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding",
    "--disable-features=CalculateNativeWinOcclusion",
    "about:blank",
  ], { env: { ...process.env, HOME: options.home }, stdio: "ignore" });
}

/* ── viewports ──────────────────────────────────────────────────────────── */

export type Surface = "desktop" | "phone";

/** The two viewports every profile here reports, as explicit metrics. The
    desktop one is an override like the phone's on purpose: a window sized
    1280x800 from the command line gives the PAGE 1280x713, and a table that
    says 1280x800 then describes something that was never measured. */
export const VIEWPORTS: Record<Surface, { width: number; height: number; deviceScaleFactor: number; mobile: boolean }> = {
  desktop: { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
  phone: { width: 390, height: 844, deviceScaleFactor: 2, mobile: true },
};

export async function setViewport(cdp: Cdp, surface: Surface): Promise<void> {
  await cdp.send("Emulation.setDeviceMetricsOverride", VIEWPORTS[surface]);
  await cdp.send("Emulation.setTouchEmulationEnabled", surface === "phone" ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  await cdp.send("Emulation.setEmulatedMedia", {
    features: surface === "phone"
      ? [{ name: "pointer", value: "coarse" }, { name: "hover", value: "none" }]
      : [{ name: "pointer", value: "fine" }, { name: "hover", value: "hover" }],
  });
}

/** What the PAGE actually got, which is the only viewport worth reporting. */
export async function assertViewport(cdp: Cdp, surface: Surface): Promise<{ width: number; height: number; dpr: number }> {
  const seen = await cdp.evaluate<{ width: number; height: number; dpr: number }>(
    "({ width: window.innerWidth, height: window.innerHeight, dpr: window.devicePixelRatio })",
  );
  const want = VIEWPORTS[surface];
  if (seen.width !== want.width || seen.height !== want.height) {
    throw new Error(`${surface} viewport is ${seen.width}x${seen.height}, not the ${want.width}x${want.height} this profile reports`);
  }
  return seen;
}

/* ── raw CDP ────────────────────────────────────────────────────────────── */

export class Cdp {
  private seq = 0;
  private readonly pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
  private readonly waiters = new Map<string, Array<(params: unknown) => void>>();
  private constructor(private readonly ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { id?: number; method?: string; params?: unknown; error?: { message?: string; code?: number }; result?: unknown };
      if (message.id === undefined) {
        if (message.method) {
          const list = this.waiters.get(message.method);
          if (list?.length) {
            this.waiters.delete(message.method);
            for (const resolve of list) resolve(message.params);
          }
        }
        return;
      }
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(`CDP ${JSON.stringify(message.error)}`));
      else entry.resolve(message.result);
    });
  }
  /** Resolve on the next occurrence of a CDP event, or null after `timeoutMs`. */
  waitFor(method: string, timeoutMs: number): Promise<unknown | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const list = this.waiters.get(method) ?? [];
        this.waiters.set(method, list.filter((entry) => entry !== settle));
        resolve(null);
      }, timeoutMs);
      const settle = (params: unknown) => {
        clearTimeout(timer);
        resolve(params);
      };
      this.waiters.set(method, [...(this.waiters.get(method) ?? []), settle]);
    });
  }
  static async connect(url: string): Promise<Cdp> {
    const ws = new WebSocket(url);
    await new Promise<void>((resolve, reject) => {
      ws.addEventListener("open", () => resolve(), { once: true });
      ws.addEventListener("error", () => reject(new Error("CDP websocket failed to open")), { once: true });
    });
    return new Cdp(ws);
  }
  send<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (value: unknown) => void, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  /** Evaluate an expression (may be a promise) and return its JSON value. */
  async evaluate<T>(expression: string): Promise<T> {
    const result = await this.send<{ result: { value?: T }; exceptionDetails?: { text: string; exception?: { description?: string } } }>("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const details = result.exceptionDetails as { text: string; exception?: { description?: string; value?: unknown } };
      throw new Error(`${details.exception?.description ?? details.text}\n${JSON.stringify(details).slice(0, 1200)}\nexpression: ${expression.slice(0, 400)}`);
    }
    return result.result.value as T;
  }
  close(): void {
    this.ws.close();
  }
}

/** The port Chrome chose for `--remote-debugging-port=0`, read from the file
    it writes into its profile, so a run never has to guess a free port. */
export async function devToolsPort(userDataDir: string, timeoutMs = 20_000): Promise<number> {
  const file = path.join(userDataDir, "DevToolsActivePort");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const port = Number(fs.existsSync(file) ? fs.readFileSync(file, "utf8").split("\n")[0] : NaN);
    if (Number.isInteger(port) && port > 0) return port;
    await Bun.sleep(100);
  }
  throw new Error("headless chrome reported no DevTools port");
}

export async function pageWebSocketUrl(cdpPort: number): Promise<string> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    try {
      const targets = (await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json()) as Array<{ type: string; webSocketDebuggerUrl: string }>;
      const page = targets.find((target) => target.type === "page");
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      /* chrome still starting */
    }
    await Bun.sleep(250);
  }
  throw new Error("headless chrome exposed no page target");
}

/* ── in-page measurement ────────────────────────────────────────────────── */

/** Installed once per document: milestone polling per animation frame. */
export const PROBE = String.raw`
(() => {
  if (window.__profile) return;
  const pane = (path) => document.querySelector('[data-link-path="' + path + '"]');
  const probe = {
    rows: (path) => { const el = pane(path); return el ? el.querySelectorAll('[data-feed-kind]').length : 0; },
    ringed: (path) => { const node = document.querySelector('[data-scheme-node="' + path + '"]'); return !!(node && node.querySelector(':scope > .ring-2')); },
    rail: () => { const el = document.querySelector('button[aria-current="page"]'); return el ? el.textContent.trim() : ""; },
    skeleton: () => !!document.querySelector('[role="status"][aria-busy="true"][aria-live="polite"]'),
    focusedPane: () => document.querySelector('[data-testid="mobile-focused-pane"] [data-link-path]'),
    focusedPath: () => { const el = probe.focusedPane(); return el ? el.getAttribute('data-link-path') : null; },
    focusedRows: () => { const el = probe.focusedPane(); return el ? el.querySelectorAll('[data-feed-kind]').length : 0; },
    chip: (path, title) => Array.from(document.querySelectorAll('button[title]')).find((b) => b.title === title) || null,
    chipActive: (title) => { const b = probe.chip(null, title); return !!(b && b.className.includes('border-accent/60')); },
    firstRow: (path) => { const el = pane(path); return el ? el.querySelector('[data-feed-key]') : null; },
    /* A node a reader can SEE: not hidden by CSS anywhere up its chain, not
       inert, laid out with a size, and with some of that box left once the
       viewport AND every clipping ancestor have cut it. A row in the DOM under
       display:none is in the DOM and nowhere else, and a row its transcript
       scroller has scrolled out of view is inside the viewport and unseen. */
    visible: (el) => {
      if (!el || !el.isConnected) return false;
      if (el.closest('[inert], [aria-hidden="true"]')) return false;
      if (typeof el.checkVisibility === 'function' && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true, contentVisibilityAuto: true })) return false;
      const box = el.getBoundingClientRect();
      if (!(box.width > 0 && box.height > 0)) return false;
      let left = Math.max(box.left, 0);
      let top = Math.max(box.top, 0);
      let right = Math.min(box.right, window.innerWidth);
      let bottom = Math.min(box.bottom, window.innerHeight);
      for (let node = el.parentElement; node && right > left && bottom > top; node = node.parentElement) {
        const style = getComputedStyle(node);
        const clips = style.overflowX !== 'visible' || style.overflowY !== 'visible' || /paint|strict|content/.test(style.contain);
        if (!clips) continue;
        /* An ancestor clips to its padding box: inside the border, and not
           over its own scrollbars. */
        const outer = node.getBoundingClientRect();
        const clipLeft = outer.left + node.clientLeft;
        const clipTop = outer.top + node.clientTop;
        left = Math.max(left, clipLeft);
        top = Math.max(top, clipTop);
        right = Math.min(right, clipLeft + node.clientWidth);
        bottom = Math.min(bottom, clipTop + node.clientHeight);
      }
      return right > left && bottom > top;
    },
    /* The target's rows a reader can see, in the pane that is ACTIVE for it:
       on the phone the focused pane, and only while it shows this path; on the
       desktop the board pane that carries the path. */
    activePane: (path, surface) => surface === 'phone' ? (probe.focusedPath() === path ? probe.focusedPane() : null) : pane(path),
    visibleRows: (path, surface) => {
      const el = probe.activePane(path, surface);
      if (!el || !probe.visible(el)) return 0;
      let count = 0;
      for (const row of el.querySelectorAll('[data-feed-kind]')) if (probe.visible(row)) count += 1;
      return count;
    },
    /* The milestone every reopen row times: the target's rows are on screen. */
    targetPainted: (path, surface) => probe.visibleRows(path, surface) > 0,
    /* An append is timed on ONE row: the row carrying the appended record's
       text that was not in the target's active pane when the append was armed.
       Arming records every row there, the first row node and the clock's zero;
       a row count going up says nothing about which row, where, or whether a
       reader could see it. */
    armAppend: (path, surface, marker) => {
      const el = probe.activePane(path, surface);
      if (!el) throw new Error('append armed with no active pane for the target');
      const rows = Array.from(el.querySelectorAll('[data-feed-kind]'));
      if (rows.some((row) => row.textContent.includes(marker))) throw new Error('the appended record is already in the pane before it was appended');
      probe.armed = { path, surface, marker, before: new Set(rows), first: el.querySelector('[data-feed-key]'), at: performance.now() };
      return { rows: rows.length, visibleRows: probe.visibleRows(path, surface) };
    },
    /* The new rows carrying the appended text, in the target's active pane. */
    appendedRows: () => {
      const armed = probe.armed;
      const el = armed ? probe.activePane(armed.path, armed.surface) : null;
      if (!el) return [];
      return Array.from(el.querySelectorAll('[data-feed-kind]')).filter((row) => !armed.before.has(row) && row.textContent.includes(armed.marker));
    },
    appendedPainted: () => {
      const armed = probe.armed;
      const el = armed ? probe.activePane(armed.path, armed.surface) : null;
      if (!el || !probe.visible(el)) return false;
      return probe.appendedRows().some((row) => probe.visible(row));
    },
    /* The appended row's milestone through the same confirmed frames as every
       reopen row, measured from the arming stamp, with what the pane holds
       then: its row count, whether the first row is still the same node, and
       how many rows carry the appended text (one, or it was duplicated). */
    appendedAt: async (timeoutMs) => {
      const armed = probe.armed;
      if (!armed) throw new Error('no append armed');
      const milestone = await probe.paintedAt(() => probe.appendedPainted(), timeoutMs);
      const el = probe.activePane(armed.path, armed.surface);
      const round = (value) => Math.round(value * 10) / 10;
      return {
        detectedMs: round(milestone.detected - armed.at),
        paintedMs: round(milestone.painted - armed.at),
        rafConfirmed: !!milestone.rafConfirmed,
        rows: el ? el.querySelectorAll('[data-feed-kind]').length : 0,
        visibleRows: probe.visibleRows(armed.path, armed.surface),
        appendedRows: probe.appendedRows().length,
        firstRowPreserved: !!armed.first && !!el && el.querySelector('[data-feed-key]') === armed.first,
      };
    },
    /* When transcript bytes for THIS conversation first reached the page at or
       after origin, and on which transport. A stream chunk is tied to the
       target by the subscriber id it carries; a POST /api/logs poll by the
       ids its own request body named, and only once its body COMPLETED and
       the answer actually held bytes for the target. The earliest delivery
       wins, whichever transport it came on. */
    deliveryFor: (path, origin) => {
      const net = window.__net;
      if (!net) return null;
      let best = null;
      const consider = (candidate) => {
        if (candidate.at < origin) return;
        if (best === null || candidate.at < best.at) best = candidate;
      };
      for (const stream of net.streams) {
        const seen = stream.paths[path];
        if (seen) consider({ at: seen.at, bytes: seen.bytes, via: 'stream' });
      }
      for (const entry of net.requests) {
        if (entry.bodyEnd === null || !entry.delivered) continue;
        const delivered = entry.delivered[path];
        if (delivered) consider({ at: entry.bodyEnd, bytes: delivered, via: 'poll' });
      }
      return best;
    },
    /* Where the rendered window starts in the tail stream, straight off the
       scroller. A window restored from the persisted tail starts deep in the
       file; a first read of the same file starts at 0. It is the one signal
       that says WHICH path produced the rows on screen. */
    windowStart: (path) => {
      const el = pane(path) || probe.focusedPane();
      const scroller = el ? el.querySelector('[data-tail-lines-start]') : document.querySelector('[data-tail-lines-start]');
      return scroller ? Number(scroller.getAttribute('data-tail-lines-start')) : null;
    },
    /* Poll until every named check holds; report when EACH one first held. */
    untilEach: (checks, timeoutMs) => new Promise((resolve, reject) => {
      const start = performance.now();
      const at = {};
      const tick = () => {
        for (const [key, fn] of Object.entries(checks)) {
          if (at[key] !== undefined) continue;
          let ok = false;
          try { ok = fn(); } catch (error) { reject(error); return; }
          if (ok) at[key] = Math.round((performance.now() - start) * 10) / 10;
        }
        if (Object.keys(checks).every((key) => at[key] !== undefined)) { resolve(at); return; }
        if (performance.now() - start > timeoutMs) { reject(new Error('milestones not reached: ' + JSON.stringify(at) + ' :: ' + document.body.innerText.slice(0, 200))); return; }
        setTimeout(tick, 2);
      };
      tick();
    }),
    /* Network requests that started after sinceMs (a performance.now() stamp): when, how long, what. */
    requestsSince: (sinceMs) => performance.getEntriesByType('resource')
      .filter((entry) => entry.startTime >= sinceMs && entry.name.includes('/api/'))
      .map((entry) => { const u = new URL(entry.name); return { at: Math.round(entry.startTime - sinceMs), ms: Math.round(entry.duration), name: (u.pathname + u.search).slice(0, 90) }; }),
    /* The milestone a reader can SEE. The poll is what notices the DOM; the
       two animation frames after it are what make the answer a frame that was
       rendered rather than a timer reading — the first callback runs before
       the paint of the frame the change is in, the second after it — and the
       check must STILL hold in each of them: a row that flickered in and out
       between frames was never shown, and the wait starts over. A renderer
       that produces no frame within a second is a milestone that was never
       confirmed, and it is rejected: a timer reading is not a paint. */
    paintedAt: (check, timeoutMs) => new Promise((resolve, reject) => {
      const start = performance.now();
      const attempt = () => probe.until(check, Math.max(1, timeoutMs - (performance.now() - start))).then((milestone) => {
        const detected = performance.now();
        let settled = false;
        const fallback = setTimeout(() => {
          if (settled) return;
          settled = true;
          reject(new Error('milestone not confirmed: no animation frame within 1000 ms of ' + check.toString().slice(0, 160)));
        }, 1000);
        const lost = () => {
          settled = true;
          clearTimeout(fallback);
          if (performance.now() - start > timeoutMs) reject(new Error('milestone not reached: never held through two frames: ' + check.toString().slice(0, 160)));
          else attempt();
        };
        requestAnimationFrame(() => {
          if (settled) return;
          if (!check()) { lost(); return; }
          requestAnimationFrame(() => {
            if (settled) return;
            if (!check()) { lost(); return; }
            settled = true;
            clearTimeout(fallback);
            resolve({ ...milestone, detected: Math.round(detected * 10) / 10, painted: Math.round(performance.now() * 10) / 10, rafConfirmed: true });
          });
        });
      }, reject);
      attempt();
    }),
    /* What the network probe recorded for this document, trimmed to one step.
       Both bounds are performance.now() stamps; a whole document starts at 0. */
    net: (since, until) => {
      const net = window.__net;
      if (!net) return null;
      const within = (at) => at !== null && at >= since && at <= until;
      const requests = net.requests.filter((entry) => within(entry.end));
      const streams = net.streams.filter((entry) => entry.open >= since && entry.open <= until);
      return {
        requests: requests.map((entry) => ({ url: entry.url, start: entry.start, end: entry.end, bodyEnd: entry.bodyEnd, bytes: entry.bytes, paths: entry.ids ? Object.values(entry.ids) : null })),
        streams: streams.map((entry) => ({ url: entry.url, open: entry.open, connected: entry.connected, firstChunkAt: entry.firstChunkAt, bytes: entry.bytes, chunks: entry.chunks, paths: entry.paths })),
        /* Every stream, so a step that rides a connection opened earlier can
           still find the chunk that carried its transcript. */
        allStreams: net.streams.map((entry) => ({ open: entry.open, paths: entry.paths })),
        paint: net.paint,
        storedTails: net.storedTails,
        storeKeys: net.storeKeys || [],
        streamCount: net.streams.length,
        longtasks: net.longtasks.filter((entry) => entry.start + entry.duration >= since && entry.start <= until),
      };
    },
    /* Poll on a short timer until check() holds; resolve with real ms since the
       call and the animation frames that elapsed meanwhile. Headless Chrome
       throttles requestAnimationFrame for an unfocused page, so the frame
       counter is an observer, never the clock the poll rides on. */
    until: (check, timeoutMs, watch) => new Promise((resolve, reject) => {
      const start = performance.now();
      let frames = 0;
      let counting = true;
      const seen = {};
      const frame = () => { if (!counting) return; frames += 1; requestAnimationFrame(frame); };
      requestAnimationFrame(frame);
      const tick = () => {
        if (watch) for (const [key, fn] of Object.entries(watch)) if (fn()) seen[key] = true;
        let ok = false;
        try { ok = check(); } catch (error) { counting = false; reject(error); return; }
        if (ok) { counting = false; resolve({ ms: Math.round((performance.now() - start) * 10) / 10, frames, seen }); return; }
        if (performance.now() - start > timeoutMs) {
          counting = false;
          const nodes = Array.from(document.querySelectorAll('[data-scheme-node]')).map((node) => [String(node.getAttribute('data-scheme-node')).split('/').pop(), !!node.querySelector(':scope > .ring-2'), node.querySelectorAll('[data-feed-kind]').length]);
          reject(new Error('milestone not reached: ' + check.toString().slice(0, 160) + ' :: hash=' + location.hash.slice(0, 80) + ' rail=' + probe.rail() + ' skeleton=' + probe.skeleton() + ' nodes=' + JSON.stringify(nodes) + ' focused=' + probe.focusedPath() + ' :: ' + document.body.innerText.slice(0, 160).replace(/\n/g, ' ')));
          return;
        }
        setTimeout(tick, 2);
      };
      tick();
    }),
  };
  window.__profile = probe;
})();
`;

/**
 * Installed BEFORE any application code, in every document: what the page's
 * own resource timeline cannot answer.
 *
 * The Viewer carries transcript bytes on a server-sent event stream that never
 * ends, and a resource entry's `responseEnd` for such a stream lands when the
 * stream CLOSES — long after the rows it delivered were painted, which is why
 * a reopen used to be recorded as having had no log request at all. So the
 * stream is instrumented where the bytes actually arrive: when it opened, when
 * the first chunk for each transcript landed, and how many bytes that was.
 * `fetch` is wrapped for the same reason on the request side, and the paint
 * and long-task observers give the client-side half of the attribution.
 */
export const NETWORK_PROBE = String.raw`
(() => {
  /* What this document STARTS with, read before a line of application code
     runs: how many conversations already have a persisted tail here. It is
     what makes a "cold open" row provably cold and a "reopen" row provably
     warm, instead of both being claims about what the driver meant to set up.
     Read again when the ORIGIN changes under the same global: Chrome reuses
     the window of a frame's initial empty document for the first real
     navigation into it, and that first reading was of an opaque origin's
     empty storage — which is not what the document that follows can see. */
  const readStore = (into) => {
    try {
      let count = 0;
      const keys = [];
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (!key) continue;
        /* Shortened: a transcript path is a private path. */
        keys.push(key.length > 40 ? key.slice(0, 12) + '…' + key.slice(-12) : key);
        if (key.indexOf('llvTail:') === 0 && key.indexOf(':index') < 0) count += 1;
      }
      into.storedTails = count;
      into.storeKeys = keys;
    } catch (error) {
      into.storedTails = -1;
      into.storeKeys = [];
    }
    into.storeOrigin = location.origin;
  };
  if (window.__net) {
    if (window.__net.storeOrigin !== location.origin) readStore(window.__net);
    return;
  }
  const round = (value) => Math.round(value * 10) / 10;
  const net = { requests: [], streams: [], paint: {}, longtasks: [] };
  window.__net = net;
  readStore(net);
  try {
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) net.paint[entry.name] = round(entry.startTime); }).observe({ type: 'paint', buffered: true });
  } catch (error) { net.paintObserver = String(error); }
  try {
    new PerformanceObserver((list) => { for (const entry of list.getEntries()) net.longtasks.push({ start: round(entry.startTime), duration: round(entry.duration) }); }).observe({ type: 'longtask', buffered: true });
  } catch (error) { net.longtaskObserver = String(error); }
  const realFetch = window.fetch;
  /* A fetch resolves when the HEADERS arrive, which for a poll can be long
     before its body has: end is that moment, bodyEnd the one the
     body completed. A POST /api/logs names the transcripts it polls for in
     its own body, by id; delivered is filled from the answer the Viewer
     itself parsed — the app's own json() call is wrapped, so the probe
     never parses a payload of its own — with the bytes each transcript got. */
  window.fetch = function (input, init) {
    const url = String(typeof input === 'string' ? input : (input && input.url) || input);
    const entry = { url: url.slice(0, 200), start: round(performance.now()), end: null, bodyEnd: null, bytes: null, ids: null, delivered: null };
    if (net.requests.length < 2000) net.requests.push(entry);
    if (url.includes('/api/logs') && init && typeof init.body === 'string') {
      try {
        const ids = {};
        for (const req of JSON.parse(init.body).reqs || []) ids[String(req.id)] = req.path;
        entry.ids = ids;
      } catch (error) { entry.idsError = String(error); }
    }
    const settle = (response) => {
      entry.end = round(performance.now());
      const length = response && response.headers ? response.headers.get('content-length') : null;
      entry.bytes = length === null || length === undefined ? null : Number(length);
      const bodyDone = response && typeof response.clone === 'function'
        ? response.clone().arrayBuffer().then((body) => {
          entry.bodyEnd = round(performance.now());
          entry.bytes = body.byteLength;
        }, () => { entry.bodyFailed = true; })
        : Promise.resolve();
      if (entry.ids && response && typeof response.json === 'function') {
        const json = response.json.bind(response);
        /* Settled with the body's own completion, whichever of the two
           branches of the tee the event loop finishes first. */
        response.json = () => Promise.all([json(), bodyDone]).then(([value]) => {
          const delivered = {};
          const chunks = (value && value.chunks) || {};
          for (const id of Object.keys(chunks)) {
            const path = entry.ids[id];
            const data = chunks[id] && chunks[id].data;
            if (path && typeof data === 'string' && data.length > 0) delivered[path] = data.length;
          }
          entry.delivered = delivered;
          return value;
        });
      }
      return response;
    };
    return realFetch.call(this, input, init).then(settle, (error) => { entry.end = round(performance.now()); throw error; });
  };
  const sources = [];
  /* Every stream this document opened, closed on demand. A driven sequence of
     documents otherwise leaves one never-ending stream per document holding a
     socket, and Chrome allows six per origin over HTTP/1.1: the next document
     then waits ~57 s for one to be freed, which is a property of the DRIVER,
     not of a reopen. A real reader never opens twelve documents in a minute.
     (The Viewer's stream never ending is real, and is #1958.) */
  net.closeStreams = () => {
    let closed = 0;
    for (const source of sources) {
      try { source.close(); closed += 1; } catch (error) { /* already gone */ }
    }
    sources.length = 0;
    return closed;
  };
  const RealEventSource = window.EventSource;
  if (RealEventSource) {
    const Patched = function (url, config) {
      const source = new RealEventSource(url, config);
      sources.push(source);
      const record = { url: String(url).slice(0, 160), open: round(performance.now()), connected: null, firstChunkAt: null, chunks: 0, bytes: 0, paths: {} };
      if (net.streams.length < 500) net.streams.push(record);
      const ids = {};
      try {
        const subs = JSON.parse(decodeURIComponent(String(url).split('subs=')[1] || '[]'));
        for (const sub of subs) ids[String(sub.id)] = sub.path;
      } catch (error) { record.subsError = String(error); }
      source.addEventListener('open', () => { record.connected = round(performance.now()); });
      source.addEventListener('chunk', (event) => {
        const at = round(performance.now());
        const data = event.data || '';
        /* The subscriber id only. Parsing a 768 kB payload here would BE the
           measurement; its length is the payload size we want to report. */
        const id = /^\{"id":"([^"]{1,12})"/.exec(data);
        const path = id ? ids[id[1]] : undefined;
        record.chunks += 1;
        record.bytes += data.length;
        if (record.firstChunkAt === null) record.firstChunkAt = at;
        if (path) {
          const seen = record.paths[path];
          if (!seen) record.paths[path] = { at: at, bytes: data.length, chunks: 1 };
          else { seen.bytes += data.length; seen.chunks += 1; }
        }
      });
      return source;
    };
    Patched.prototype = RealEventSource.prototype;
    Patched.CONNECTING = RealEventSource.CONNECTING;
    Patched.OPEN = RealEventSource.OPEN;
    Patched.CLOSED = RealEventSource.CLOSED;
    window.EventSource = Patched;
  }
})();
`;

/** What one measured step saw on the wire and on the main thread. */
export interface NetworkTrace {
  requests: Array<{ url: string; start: number; end: number; bodyEnd: number | null; bytes: number | null; paths: string[] | null }>;
  streams: Array<{ url: string; open: number; connected: number | null; firstChunkAt: number | null; bytes: number; chunks: number; paths: Record<string, { at: number; bytes: number; chunks: number }> }>;
  allStreams: Array<{ open: number; paths: Record<string, { at: number; bytes: number; chunks: number }> }>;
  paint: Record<string, number>;
  /** Persisted conversation tails present when the document started. */
  storedTails: number;
  storeKeys: string[];
  streamCount: number;
  longtasks: Array<{ start: number; duration: number }>;
}

export interface Milestone {
  ms: number;
  frames: number;
  seen: Record<string, boolean>;
  /** API requests the page issued between the gesture and the milestone. */
  requests?: Array<{ at: number; ms: number; name: string }>;
  /** False when the milestone never showed within its budget: the row says
      so and the run goes on, so one missing ring cannot blank a whole table. */
  reached?: false;
}

export interface ProfileRow {
  surface: string;
  step: string;
  ms: number | string;
  frames: number | string;
  notes: string;
}

export const describeRequests = (requests: Array<{ at: number; ms: number; name: string }>): string =>
  requests.slice(0, 12).map((entry) => `+${entry.at}ms ${entry.name} (${entry.ms}ms)`).join("; ");

/** The rows of one profile run, and the markdown table they render to. */
export class ProfileTable {
  readonly rows: ProfileRow[] = [];
  record(surface: string, step: string, milestone: Milestone, notes = ""): void {
    const requestNotes = milestone.requests?.length ? `requests ${describeRequests(milestone.requests)}` : "";
    const missed = milestone.reached === false ? "NOT REACHED within the budget" : "";
    const allNotes = [missed, notes, requestNotes].filter(Boolean).join("; ");
    const ms = milestone.reached === false ? `>${milestone.ms}` : milestone.ms;
    this.rows.push({ surface, step, ms, frames: milestone.frames, notes: allNotes });
    console.log(`  ${surface} | ${step} | ${ms} ms | ${milestone.frames} frames${allNotes ? " | " + allNotes : ""}`);
  }
  markdown(title: string, msHeader = "real ms since gesture"): string {
    const header = `| surface | step | ${msHeader} | frames | notes |\n|---|---|---:|---:|---|`;
    const body = this.rows.map((row) => `| ${row.surface} | ${row.step} | ${row.ms} | ${row.frames} | ${row.notes} |`).join("\n");
    return `${title}\n${header}\n${body}\n`;
  }
}

const js = JSON.stringify;

/** Run `gesture`, then wait for every named check; returns when each first held plus the API requests the step issued. */
export async function measureEach(cdp: Cdp, gesture: string, checks: Record<string, string>, timeoutMs = 30_000): Promise<{ at: Record<string, number>; requests: Array<{ at: number; ms: number; name: string }> }> {
  const source = `{${Object.entries(checks).map(([key, expression]) => `${js(key)}: () => (${expression})`).join(",")}}`;
  return cdp.evaluate(`(async () => {
    const p = window.__profile;
    const since = performance.now();
    ${gesture};
    const at = await p.untilEach(${source}, ${timeoutMs});
    return { at, requests: p.requestsSince(since) };
  })()`);
}

/** Run `gesture` (a JS statement) and wait for `check` (a JS expression) on the
    same frame clock; the API requests issued meanwhile ride along, so a slow
    step can be attributed to the server or to the client. */
export async function measure(cdp: Cdp, gesture: string, check: string, timeoutMs = 20_000, watch: Record<string, string> = {}): Promise<Milestone> {
  const watchSource = `{${Object.entries(watch).map(([key, expression]) => `${js(key)}: () => (${expression})`).join(",")}}`;
  try {
    return await cdp.evaluate<Milestone>(`(async () => {
      const p = window.__profile;
      const since = performance.now();
      ${gesture};
      const milestone = await p.until(() => (${check}), ${timeoutMs}, ${watchSource});
      return { ...milestone, requests: p.requestsSince(since) };
    })()`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!message.includes("milestone not reached")) throw error;
    console.log(`  ! not reached within ${timeoutMs} ms: ${message.split("\n")[0]?.slice(0, 400)}`);
    return { ms: timeoutMs, frames: "" as unknown as number, seen: {}, reached: false };
  }
}

export async function navigate(cdp: Cdp, url: string): Promise<void> {
  /* The load event of the NEW document, armed before the navigation is
     issued: polling readyState right after Page.navigate reads the old
     document, and a probe installed there dies with its context. */
  const loaded = cdp.waitFor("Page.loadEventFired", 120_000);
  await cdp.send("Page.navigate", { url });
  await loaded;
  await cdp.evaluate(PROBE);
}

/** Install the network probe for every document this target will load, and
    keep the page in the foreground so its frames are produced at all. */
export async function armDocuments(cdp: Cdp): Promise<void> {
  await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: NETWORK_PROBE });
  await cdp.send("Page.bringToFront");
}
