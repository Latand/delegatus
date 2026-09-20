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
    "about:blank",
  ], { env: { ...process.env, HOME: options.home }, stdio: "ignore" });
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
