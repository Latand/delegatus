/**
 * Regenerate every screenshot the README shows:
 *
 *   bun run build && bun scripts/capture-readme-media.ts
 *
 * The driver seeds an invented home (scripts/readme-demo-state.ts) under a
 * capture root outside the checkout, serves the production build against it
 * on a port the OS assigns, and captures each shot twice: a PNG for human
 * review, copied to the evidence directory and never committed, and a vector
 * SVG, which is what the README uses.
 *
 * Why vectors: the publication gate (scripts/privacy-publication-gate.ts)
 * admits a committed raster only when its checked-in generator reproduces it
 * byte for byte inside the gate, and a browser screenshot cannot be
 * reproduced that way. Chrome prints the frame to PDF and poppler turns the
 * page into an SVG whose glyphs are paths, so the file carries no raster and
 * no font dependency. Because OCR does not read an SVG, the driver itself
 * refuses a frame whose text contains this machine's home, user name or
 * capture root, and every shot declares the text it must and must not show.
 *
 * Flags: --serve keeps the server up for inspection instead of capturing.
 * Requirements: a completed `bun run build`, Chrome (CHROME_BIN, default
 * /usr/bin/google-chrome-stable) and poppler's `pdftocairo`.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import type { Page } from "playwright-core";

import { seedDemoAccounts, seedDemoHome, WORKING_CONVERSATIONS, type DemoProject } from "./readme-demo-state";

export const README_MEDIA_DIR = "docs/media/readme";
export const CAPTURE_ROOT = process.env.LLV_README_CAPTURE_ROOT ?? "/var/tmp/llv-readme-capture";
export const EVIDENCE_DIR = process.env.LLV_README_EVIDENCE_DIR ?? "/var/tmp/llv-readme-evidence";

type Target =
  | { kind: "overview" }
  | { kind: "project"; project: DemoProject }
  | { kind: "conversation"; key: string };

export type ReadmeShot = {
  id: string;
  target: Target;
  viewport: { width: number; height: number };
  /** Text that must be on the frame, so a silent empty state fails. */
  requiredText: string[];
  /** Text that must not be on it: retired vocabulary, broken states. */
  absentText?: string[];
  /** In-page preparation after the target opened. */
  prepare?: (page: Page) => Promise<void>;
  description: string;
};

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

const clickLabel = (page: Page, label: string) => page.locator(`[aria-label="${label}"]`).first().click();
const clickText = (page: Page, text: string) => page.getByText(text, { exact: false }).first().click();
/* A project without an orchestrator opens with the create draft unfolded;
   the board shots fold it to its one-line bar. */
const foldOrchestrator = (page: Page) => clickLabel(page, "Collapse the orchestrator chat (O)");

export const SHOTS: ReadmeShot[] = [
  {
    id: "board",
    target: { kind: "project", project: "harbor-api" },
    viewport: DESKTOP,
    requiredText: ["Idempotent refunds", "Rotate webhook signing keys", "Move invoices to the new ledger", "Document refund error codes"],
    absentText: ["tmux"],
    prepare: foldOrchestrator,
    description: "A project's board: tasks by status, the agents working on each, and a running pipeline; account limits in the sidebar.",
  },
  {
    id: "conversation",
    target: { kind: "conversation", key: "refunds-builder" },
    viewport: { width: 1280, height: 960 },
    requiredText: ["Idempotency-Key", "4 pass", "UPDATE"],
    prepare: async (page) => {
      await clickLabel(page, "Open as a full pane");
      await page.waitForTimeout(800);
      await clickText(page, "1 search");
      await page.waitForTimeout(500);
      await clickText(page, "wrote 1 file");
    },
    description: "A Claude Code conversation read as a chat: an edit shown as a diff, a test run with its output, and the answer.",
  },
  {
    id: "pipeline",
    target: { kind: "project", project: "harbor-api" },
    viewport: DESKTOP,
    requiredText: ["Idempotent refunds", "Build", "Review", "Verify", "passed", "running", "waiting"],
    prepare: async (page) => {
      await foldOrchestrator(page);
      await page.waitForTimeout(500);
      await clickLabel(page, "Expand all 3 stages");
    },
    description: "A pipeline opened from its card: the stage graph with its fail edge, and each stage's conversation side by side.",
  },
  {
    id: "accounts",
    target: { kind: "project", project: "harbor-api" },
    viewport: DESKTOP,
    requiredText: ["Claude accounts", "Work", "Main", "Opus"],
    prepare: async (page) => {
      await foldOrchestrator(page);
      await page.waitForTimeout(500);
      await clickLabel(page, "Claude accounts — switch or add");
      await page.waitForSelector('[role="dialog"][aria-label="Claude accounts"]');
    },
    description: "Claude accounts with their five-hour, weekly and per-model limits; switch the active account or add one here.",
  },
  {
    id: "phone-conversation",
    target: { kind: "conversation", key: "refunds-builder" },
    viewport: PHONE,
    requiredText: ["Idempotency-Key"],
    description: "The same conversation on a 390 px phone screen.",
  },
];

/* ── seeded home ────────────────────────────────────────────────────────── */

export function buildCaptureEnvironment(root: string, source = process.env): NodeJS.ProcessEnv {
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  const config = path.join(home, ".config");
  const state = path.join(config, "agent-log-viewer", "state");
  return {
    NODE_ENV: "production",
    PATH: source.PATH,
    HOME: home,
    TMPDIR: tmp,
    TMP: tmp,
    TEMP: tmp,
    TMUX_TMPDIR: path.join(root, "notmux"),
    XDG_CONFIG_HOME: config,
    XDG_CACHE_HOME: path.join(root, "cache"),
    XDG_RUNTIME_DIR: path.join(root, "runtime"),
    LLV_STATE_OWNER: "viewer",
    LLV_STATE_DIR: state,
    LLV_CLAUDE_HOME: path.join(home, ".claude"),
    LLV_CODEX_HOME: path.join(home, ".codex"),
    /* A stub that exits, so nothing the page triggers reaches a real engine. */
    LLV_CODEX_BINARY: path.join(root, "bin", "codex"),
    LLV_ACCOUNT_CONTROLLER_DISABLED: "1",
    LLV_REAPER_ENABLED: "0",
    LLV_RESOURCES_FIXTURE: path.join(state, "resources.json"),
    NEXT_TELEMETRY_DISABLED: "1",
    TZ: "UTC",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    LOGNAME: "demo",
    USER: "demo",
    SHELL: "/bin/sh",
  };
}

async function materialize(env: NodeJS.ProcessEnv, now: number) {
  fs.rmSync(CAPTURE_ROOT, { recursive: true, force: true });
  const uid = process.getuid?.() ?? 1000;
  for (const directory of [env.HOME!, env.TMPDIR!, path.join(env.TMPDIR!, `claude-${uid}`), env.TMUX_TMPDIR!, env.XDG_CACHE_HOME!, env.XDG_RUNTIME_DIR!, env.LLV_STATE_DIR!, path.dirname(env.LLV_CODEX_BINARY!)]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(env.LLV_CODEX_BINARY!, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  const layout = seedDemoHome(env.HOME!, env.LLV_STATE_DIR!, now);
  /* The account modules resolve their directories from this process's
     environment, so point it at the demo home before loading them. */
  for (const key of ["HOME", "XDG_CONFIG_HOME", "LLV_STATE_DIR", "LLV_CLAUDE_HOME", "LLV_CODEX_HOME", "TMPDIR"] as const) process.env[key] = env[key];
  await seedDemoAccounts(env.HOME!, now);
  return layout;
}

/* ── server ─────────────────────────────────────────────────────────────── */

/** A port the OS hands out, never one this script picked and hoped was free. */
async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address();
      if (typeof address === "string" || address === null) {
        probe.close(() => reject(new Error("no port assigned")));
        return;
      }
      const port = address.port;
      probe.close(() => resolve(port));
    });
  });
}

async function waitForServer(url: string, child: ChildProcess, logs: () => string): Promise<void> {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`server exited: ${logs()}`);
    try {
      const response = await fetch(`${url}/api/files`, { signal: AbortSignal.timeout(10_000) });
      if (response.ok) return;
    } catch { /* not listening yet */ }
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error(`server did not become ready: ${logs()}`);
}

function collectOutput(child: ChildProcess): () => string {
  const lines: string[] = [];
  const keep = (chunk: Buffer) => {
    lines.push(chunk.toString());
    if (lines.length > 200) lines.shift();
  };
  child.stdout?.on("data", keep);
  child.stderr?.on("data", keep);
  return () => lines.join("");
}

/* ── vector conversion ──────────────────────────────────────────────────── */

export function pdfToSvg(pdf: Buffer, target: string): void {
  const scratch = fs.mkdtempSync(path.join(CAPTURE_ROOT, "svg-"));
  try {
    const pdfPath = path.join(scratch, "frame.pdf");
    fs.writeFileSync(pdfPath, pdf);
    const svgPath = path.join(scratch, "frame.svg");
    const conversion = spawnSync("pdftocairo", ["-svg", "-f", "1", "-l", "1", pdfPath, svgPath], { encoding: "utf8" });
    if (conversion.status !== 0) throw new Error(`pdftocairo failed: ${conversion.stderr || conversion.stdout}`);
    const svg = fs.readFileSync(svgPath, "utf8");
    if (/<image\b|data:image\//.test(svg)) throw new Error(`${path.basename(target)}: the vector frame embeds a raster`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, svg);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Strings from this machine that must never appear on a committed frame. */
function forbiddenHostText(): string[] {
  const values = [os.homedir(), os.userInfo().username, CAPTURE_ROOT, os.hostname()];
  return values.filter((value) => value && value.length >= 3);
}

/* ── run ────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const env = buildCaptureEnvironment(CAPTURE_ROOT);
  const now = Date.now();
  const layout = await materialize(env, now);

  const port = await freePort();
  const server = spawn(
    process.execPath,
    ["--bun", path.join(repoRoot, "node_modules/.bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const serverPid = server.pid;
  fs.writeFileSync(path.join(CAPTURE_ROOT, "server.pid"), `${serverPid}\n`);
  const stop = () => {
    if (serverPid !== undefined && server.exitCode === null) process.kill(serverPid, "SIGTERM");
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.on(signal, () => {
      stop();
      process.exit(130);
    });
  }
  const logs = collectOutput(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(baseUrl, server, logs);
    process.stdout.write(`serving ${baseUrl} (server pid ${serverPid})\n`);
    if (process.argv.includes("--serve")) {
      await new Promise(() => {});
      return;
    }
    await captureShots(repoRoot, baseUrl, layout);
  } finally {
    stop();
    await new Promise((resolve) => setTimeout(resolve, 800));
    if (serverPid !== undefined && server.exitCode === null) process.kill(serverPid, "SIGKILL");
  }
}

type Layout = Awaited<ReturnType<typeof materialize>>;

async function openTarget(page: Page, baseUrl: string, target: Target, layout: Layout): Promise<void> {
  await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
  if (target.kind === "overview") return;
  if (target.kind === "project") {
    await page.goto(`${baseUrl}/#p=${encodeURIComponent(layout.ids[target.project])}`, { waitUntil: "networkidle" });
    return;
  }
  const file = layout.files[target.key];
  if (!file) throw new Error(`no transcript seeded for ${target.key}`);
  await page.goto(`${baseUrl}/#f=${encodeURIComponent(file.path)}`, { waitUntil: "networkidle" });
}

async function captureShots(repoRoot: string, baseUrl: string, layout: Layout): Promise<void> {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN ?? "/usr/bin/google-chrome-stable",
    args: ["--font-render-hinting=none", "--force-color-profile=srgb"],
  });
  const forbidden = forbiddenHostText();
  const only = process.argv.find((arg) => arg.startsWith("--only="))?.slice("--only=".length).split(",");
  const manifest: unknown[] = [];
  try {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    for (const shot of SHOTS) {
      if (only && !only.includes(shot.id)) continue;
      const context = await browser.newContext({ viewport: shot.viewport, deviceScaleFactor: 2, colorScheme: "dark", isMobile: shot.viewport.width < 600, hasTouch: shot.viewport.width < 600 });
      const page = await context.newPage();
      const recent = new Date(Date.now() - 20_000);
      for (const key of WORKING_CONVERSATIONS) fs.utimesSync(layout.files[key]!.path, recent, recent);
      await page.addInitScript(() => {
        localStorage.setItem("llv_lang", "en");
        localStorage.setItem("llvSound", "0");
      });
      await openTarget(page, baseUrl, shot.target, layout);
      await page.waitForTimeout(2_500);
      if (shot.prepare) await shot.prepare(page);
      await page.waitForTimeout(1_000);

      const text = await page.evaluate(() => document.body.innerText);
      for (const required of shot.requiredText) {
        if (!text.includes(required)) throw new Error(`${shot.id}: missing text ${JSON.stringify(required)}`);
      }
      for (const absent of [...(shot.absentText ?? []), ...forbidden]) {
        if (text.includes(absent)) throw new Error(`${shot.id}: frame shows ${JSON.stringify(absent)}`);
      }

      const png = path.join(EVIDENCE_DIR, `${shot.id}.png`);
      await page.screenshot({ path: png });
      await page.emulateMedia({ media: "screen", colorScheme: "dark" });
      const pdf = await page.pdf({
        width: `${shot.viewport.width}px`,
        height: `${shot.viewport.height}px`,
        printBackground: true,
        pageRanges: "1",
        margin: { top: "0", bottom: "0", left: "0", right: "0" },
      });
      const svgPath = path.join(repoRoot, README_MEDIA_DIR, `${shot.id}.svg`);
      pdfToSvg(Buffer.from(pdf), svgPath);
      manifest.push({
        path: `${shot.id}.svg`,
        description: shot.description,
        viewport: shot.viewport,
        colorScheme: "dark",
        sha256: sha256(fs.readFileSync(svgPath)),
      });
      await context.close();
      process.stdout.write(`captured ${shot.id} → ${png}\n`);
    }
  } finally {
    await browser.close();
  }
  if (!only) {
    const driver = fs.readFileSync(path.join(repoRoot, "scripts/capture-readme-media.ts"));
    const seed = fs.readFileSync(path.join(repoRoot, "scripts/readme-demo-state.ts"));
    fs.writeFileSync(
      path.join(repoRoot, README_MEDIA_DIR, "provenance.json"),
      `${JSON.stringify({
        schemaVersion: 1,
        classification: "synthetic",
        generator: "scripts/capture-readme-media.ts",
        generatorSha256: sha256(driver),
        seed: "scripts/readme-demo-state.ts",
        seedSha256: sha256(seed),
        command: "bun run build && bun scripts/capture-readme-media.ts",
        assets: manifest,
      }, null, 2)}\n`,
    );
  }
}

if (import.meta.main) {
  await main();
}
