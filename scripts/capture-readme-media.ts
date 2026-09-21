/**
 * Regenerate every image the README shows:
 *
 *   bun scripts/capture-readme-media.ts
 *
 * The runner materializes the synthetic demo home outside the checkout, serves
 * the production build against it, and captures each shot twice: a PNG for
 * human review and a vector SVG — the form the README commits, because the
 * publication gate admits only assets a checked-in generator can reproduce and
 * a browser raster is not one (scripts/privacy-publication-gate.ts).
 *
 * Requirements: a completed `bun run build`, Chrome (CHROME_BIN, default
 * google-chrome-stable) and poppler's `pdftocairo`.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  DEMO_FIXED_ISO,
  DEMO_TOKEN,
  SEED_SOURCES,
  renderFixtureTemplate,
} from "./demo-capture";
import {
  assertNoRepositoryLeak,
  createProjectDirectories,
  retargetFixtureState,
  writeDemoPipelines,
  type DemoProject,
} from "./readme-demo-state";

export const README_MEDIA_DIR = "docs/media/readme";
export const CAPTURE_ROOT = process.env.LLV_README_CAPTURE_ROOT ?? "/var/tmp/llv-readme-capture";
export const EVIDENCE_DIR = process.env.LLV_README_EVIDENCE_DIR ?? "/var/tmp/llv-readme-evidence";

export type ReadmeShot = {
  id: string;
  /** Project id (`#p=`) or transcript path (`#f=`) the shot opens. */
  project: string | null;
  file: string | null;
  viewport: { width: number; height: number };
  /** Text that must be on the captured frame, so a silent empty state fails. */
  requiredText: string[];
  /** Text that must NOT be on it — retired vocabulary, leaked host state. */
  absentText?: string[];
  /** Optional in-page preparation, serialized into the browser. */
  prepare?: string;
  description: string;
};

export const claudeFixturePath = (project: string, file: string) =>
  `${DEMO_TOKEN}/.claude/projects/${DEMO_TOKEN.replace(/[^A-Za-z0-9]/g, "-")}-Projects-${project}/${file}`;

export const SHOTS: ReadmeShot[] = [];

/* ── fixture home ───────────────────────────────────────────────────────── */

export function buildCaptureEnvironment(root: string, uid: number, source = process.env): NodeJS.ProcessEnv {
  const home = path.join(root, "home");
  const tmp = path.join(root, "tmp");
  const config = path.join(home, ".config");
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
    LLV_STATE_DIR: path.join(config, "agent-log-viewer", "state"),
    LLV_CLAUDE_HOME: path.join(home, ".claude"),
    LLV_CODEX_HOME: path.join(home, ".codex"),
    LLV_ACCOUNT_CONTROLLER_DISABLED: "1",
    LLV_REAPER_ENABLED: "0",
    LLV_RESOURCES_FIXTURE: path.join(config, "agent-log-viewer", "state", "resources.json"),
    NEXT_TELEMETRY_DISABLED: "1",
    TZ: "UTC",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    LOGNAME: "demo", USER: "demo",
    SHELL: "/bin/sh",
  };
}

function materialize(repoRoot: string, env: NodeJS.ProcessEnv, uid: number): Record<DemoProject, string> {
  const root = CAPTURE_ROOT;
  fs.rmSync(root, { recursive: true, force: true });
  const home = env.HOME!;
  fs.mkdirSync(path.dirname(home), { recursive: true });
  fs.cpSync(path.join(repoRoot, SEED_SOURCES.demo), home, { recursive: true, dereference: false, errorOnExist: true });

  const directories: string[] = [];
  const visit = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const pathname = path.join(directory, entry.name);
      if (fs.lstatSync(pathname).isSymbolicLink()) throw new Error(`fixture contains a symlink: ${pathname}`);
      if (entry.isDirectory()) {
        visit(pathname);
        directories.push(pathname);
        continue;
      }
      const bytes = fs.readFileSync(pathname);
      if (bytes.includes(0)) continue;
      const text = bytes.toString("utf8");
      const rendered = renderFixtureTemplate(text, home);
      if (rendered !== text) fs.writeFileSync(pathname, rendered, "utf8");
    }
  };
  visit(home);
  for (const directory of directories.sort((left, right) => right.length - left.length)) {
    const name = path.basename(directory);
    const rendered = renderFixtureTemplate(name, home);
    if (name !== rendered) fs.renameSync(directory, path.join(path.dirname(directory), rendered));
  }

  for (const directory of [home, env.TMPDIR!, path.join(env.TMPDIR!, `claude-${uid}`), env.TMUX_TMPDIR!, env.XDG_CONFIG_HOME!, env.XDG_CACHE_HOME!, env.XDG_RUNTIME_DIR!, env.LLV_STATE_DIR!]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  const ids = createProjectDirectories(home);
  retargetFixtureState(home, ids);
  writeDemoPipelines(home, ids);
  assertNoRepositoryLeak(home);

  const instant = new Date(DEMO_FIXED_ISO);
  const touch = (directory: string) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const pathname = path.join(directory, entry.name);
      if (entry.isDirectory()) touch(pathname);
      fs.utimesSync(pathname, instant, instant);
    }
  };
  touch(home);
  fs.utimesSync(home, instant, instant);
  return ids;
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
      const response = await fetch(url, { signal: AbortSignal.timeout(4_000) });
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

/**
 * Chrome prints the framed page to a single-page PDF and poppler converts that
 * page to SVG. The glyphs arrive as paths, so the committed asset renders the
 * same everywhere and carries no font dependency and no raster.
 */
export function pdfToSvg(pdf: Buffer, target: string): void {
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "llv-readme-svg-"));
  try {
    const pdfPath = path.join(scratch, "frame.pdf");
    fs.writeFileSync(pdfPath, pdf);
    const svgPath = path.join(scratch, "frame.svg");
    const conversion = spawnSync("pdftocairo", ["-svg", "-f", "1", "-l", "1", pdfPath, svgPath], { encoding: "utf8" });
    if (conversion.status !== 0) throw new Error(`pdftocairo failed: ${conversion.stderr || conversion.stdout}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, fs.readFileSync(svgPath));
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/* ── run ────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, "..");
  const uid = process.getuid?.() ?? 1000;
  const env = buildCaptureEnvironment(CAPTURE_ROOT, uid);
  const projectIds = materialize(repoRoot, env, uid);

  const port = await freePort();
  const server = spawn(
    process.execPath,
    ["--bun", path.join(repoRoot, "node_modules/.bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const serverPid = server.pid;
  const logs = collectOutput(server);
  const baseUrl = `http://127.0.0.1:${port}`;
  try {
    await waitForServer(baseUrl, server, logs);
    process.stdout.write(`serving ${baseUrl}\n`);
    if (process.argv.includes("--serve")) {
      await new Promise(() => {});
      return;
    }
    await captureShots(repoRoot, env, baseUrl, projectIds);
  } finally {
    if (serverPid !== undefined && server.exitCode === null) {
      process.kill(serverPid, "SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (server.exitCode === null) process.kill(serverPid, "SIGKILL");
    }
  }
}

async function captureShots(
  repoRoot: string,
  env: NodeJS.ProcessEnv,
  baseUrl: string,
  projectIds: Record<DemoProject, string>,
): Promise<void> {
  const { chromium } = await import("playwright-core");
  const browser = await chromium.launch({
    executablePath: process.env.CHROME_BIN ?? "/usr/bin/google-chrome-stable",
    args: ["--font-render-hinting=none", "--force-color-profile=srgb"],
  });
  try {
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
    for (const shot of SHOTS) {
      const context = await browser.newContext({
        viewport: shot.viewport,
        deviceScaleFactor: 2,
        colorScheme: "dark",
      });
      const page = await context.newPage();
      /* The fixture is dated, so every "N ago" on the page is measured from the
         fixture instant rather than from the day the capture happened. */
      await page.addInitScript(({ captureTime }: { captureTime: number }) => {
        const NativeDate = Date;
        class CaptureDate extends NativeDate {
          constructor(...args: ConstructorParameters<typeof Date>) {
            super(...((args.length ? args : [captureTime]) as ConstructorParameters<typeof Date>));
          }
          static now() { return captureTime; }
        }
        Object.defineProperty(globalThis, "Date", { configurable: true, value: CaptureDate });
        localStorage.setItem("llv_lang", "en");
        localStorage.setItem("llvSound", "0");
      }, { captureTime: Date.parse(DEMO_FIXED_ISO) });
      const hash = shot.file
        ? `#f=${encodeURIComponent(renderFixtureTemplate(shot.file, env.HOME!))}`
        : shot.project ? `#p=${encodeURIComponent(projectIds[shot.project as DemoProject] ?? shot.project)}` : "";
      await page.goto(`${baseUrl}/`, { waitUntil: "networkidle" });
      await page.goto(`${baseUrl}/${hash}`, { waitUntil: "networkidle" });
      if (shot.prepare) await page.evaluate(shot.prepare);
      await page.waitForTimeout(1_500);

      const text = await page.evaluate(() => document.body.innerText);
      for (const required of shot.requiredText) {
        if (!text.includes(required)) throw new Error(`${shot.id}: missing text ${JSON.stringify(required)}`);
      }
      for (const absent of shot.absentText ?? []) {
        if (text.includes(absent)) throw new Error(`${shot.id}: unexpected text ${JSON.stringify(absent)}`);
      }

      await page.screenshot({ path: path.join(EVIDENCE_DIR, `${shot.id}.png`) });
      await page.emulateMedia({ media: "screen", colorScheme: "dark" });
      const pdf = await page.pdf({
        width: `${shot.viewport.width}px`,
        height: `${shot.viewport.height}px`,
        printBackground: true,
        pageRanges: "1",
        margin: { top: "0", bottom: "0", left: "0", right: "0" },
      });
      pdfToSvg(Buffer.from(pdf), path.join(repoRoot, README_MEDIA_DIR, `${shot.id}.svg`));
      await context.close();
      process.stdout.write(`captured ${shot.id}\n`);
    }
  } finally {
    await browser.close();
  }
}

if (import.meta.main) {
  await main();
}
