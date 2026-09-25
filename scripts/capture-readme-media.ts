/**
 * Regenerate every screenshot the README shows:
 *
 *   bun run build && bun scripts/capture-readme-media.ts
 *
 * The driver seeds an invented home (scripts/readme-demo-state.ts) under a
 * fresh capture directory under /var/tmp that the run allocates and never
 * clears (LLV_README_CAPTURE_ROOT may name an existing `llv-readme-*` parent
 * there), serves the production build against it
 * on a port the OS assigns, and captures each shot twice: a PNG for human
 * review, copied to the evidence directory and never committed, and a vector
 * SVG, which is what the README uses. An SVG reaches the repository only
 * after Chrome, rendering it back the way a README shows it, draws what its
 * PNG shows (judgeRenderBack); the rendered-back frame and a heat map of the
 * difference land in the evidence directory beside the PNG.
 *
 * Why vectors: the publication gate (scripts/privacy-publication-gate.ts)
 * admits a committed raster only when its checked-in generator reproduces it
 * byte for byte inside the gate, and a browser screenshot cannot be
 * reproduced that way. Chrome prints the frame to PDF and poppler turns the
 * page into an SVG whose glyphs are paths, so the file carries no raster and
 * no font dependency. The gate does not OCR an SVG, so the driver runs the
 * gate's own checks before it keeps one: the frame's text goes through the
 * gate's sensitive-text classifier, the full-frame PNG through its raster
 * inspection (OCR included), and the text must not contain this machine's
 * home, user name or host name. Every shot also declares
 * the text it must and must not show.
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

import type { Browser, Page } from "playwright-core";

import { createCaptureDirectory } from "./capture-directory";
import { inspectPaths, sensitiveClasses } from "./privacy-publication-gate";
import { seedDemoAccounts, seedDemoHome, seedDemoOrchestrator, WORKING_CONVERSATIONS, type DemoProject } from "./readme-demo-state";

export const README_MEDIA_DIR = "docs/media/readme";
/** Runs are allocated under this root; LLV_README_CAPTURE_ROOT may name an
    existing `llv-readme-*` directory beneath it to hold them instead. */
export const SCRATCH_ROOT = "/var/tmp";
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
/* A phone frame at 392 × 848 px: Chrome printed a 390 × 844 px page as
   293.04 × 633.12 pt instead of 292.5 × 633, so its vector drew the frame a
   fraction smaller than its PNG. Sizes in multiples of 8 px print exact. */
const PHONE = { width: 392, height: 848 };

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
    requiredText: ["Idempotent refunds", "Rotate webhook signing keys", "Move invoices to the new ledger", "Document refund error codes", "needs a decision · build"],
    absentText: ["tmux", "Untitled task"],
    prepare: foldOrchestrator,
    description: "A project's board: tasks by status with their icons, the agents working on each, a running pipeline's stages, and a card that names why it needs you; account limits in the sidebar.",
  },
  {
    id: "orchestrator",
    target: { kind: "project", project: "harbor-api" },
    viewport: DESKTOP,
    requiredText: ["Orchestrator", "Reports", "Take the open harbor-api work", "Paginate GET /charges is done", "review verdict"],
    absentText: ["tmux", "Untitled task", "has not reported anything yet"],
    description: "A project's orchestrator on top of its board: its chat with the operator, and beside it the log of the reports it filed.",
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
      /* The lane row's head opens the pipeline: its graph over the stages. */
      await page.locator('[data-open-stages][aria-label^="Idempotent refunds"]').first().click();
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
    requiredText: ["Idempotency-Key", "4 pass"],
    prepare: async (page) => {
      await clickText(page, "wrote 1 file");
      await page.waitForTimeout(800);
      /* The shot is the test run: scroll its call to the top of the feed, as
         a reader would; the phone then rests the call on the feed's edge. */
      await page.getByText("bun test src/refunds", { exact: false }).first().evaluate((element) => element.closest("li")?.scrollIntoView({ block: "start" }));
    },
    description: "The same conversation on a phone screen, its test run expanded.",
  },
  {
    id: "phone-board",
    target: { kind: "project", project: "harbor-api" },
    viewport: PHONE,
    requiredText: ["Inbox", "Assigned", "Blocked", "Done", "Back off webhook retries", "Idempotent refunds"],
    absentText: ["Untitled task"],
    prepare: async (page) => {
      await page.locator('[data-phone-kanban-tab="assigned"]').first().click();
      await page.waitForTimeout(600);
    },
    description: "A project's board on a phone: the four status columns as tabs, with the card that needs you pinned first.",
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
    "USER": "demo",
    SHELL: "/bin/sh",
  };
}

async function materialize(env: NodeJS.ProcessEnv, now: number) {
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
  await seedDemoOrchestrator(layout);
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

/** Returns how many raster tiles the vector frame embeds. Chrome prints CSS
    gradients (the board's dot grid, column washes) as image patterns; they
    carry no text, and the full-frame PNG they are rendered into is what the
    gate's OCR reads before the SVG is kept. */
export function pdfToSvg(pdf: Buffer, target: string, scratchParent: string): number {
  const scratch = fs.mkdtempSync(path.join(scratchParent, "svg-"));
  try {
    const pdfPath = path.join(scratch, "frame.pdf");
    fs.writeFileSync(pdfPath, pdf);
    const svgPath = path.join(scratch, "frame.svg");
    const conversion = spawnSync("pdftocairo", ["-svg", "-f", "1", "-l", "1", pdfPath, svgPath], { encoding: "utf8" });
    /* Some poppler/cairo builds assert while tearing down after the page is
       fully written; a complete document is kept, anything else fails. */
    const svg = fs.existsSync(svgPath) ? fs.readFileSync(svgPath, "utf8") : "";
    if (!svg.trimEnd().endsWith("</svg>")) throw new Error(`pdftocairo failed: ${conversion.stderr || conversion.stdout}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, svg);
    return (svg.match(/<image\b/g) ?? []).length;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

/* ── print path ─────────────────────────────────────────────────────────── */

/** A ring's box: its border-box size, where its content box starts on each
    side (border plus padding), and its corner radii in px as
    [horizontal, vertical], clockwise from the top left. */
export type RingBox = {
  width: number;
  height: number;
  inset: { top: number; right: number; bottom: number; left: number };
  radii: [[number, number], [number, number], [number, number], [number, number]];
};

type Corners = RingBox["radii"];

const round = (value: number) => Number(value.toFixed(3));

/** CSS shrinks every radius by one factor when adjacent radii overflow a side. */
function fitRadii(radii: Corners, width: number, height: number): Corners {
  const [tl, tr, br, bl] = radii;
  const sides = [[tl[0] + tr[0], width], [bl[0] + br[0], width], [tl[1] + bl[1], height], [tr[1] + br[1], height]];
  const factor = Math.min(1, ...sides.map(([sum, side]) => (sum > 0 ? side / sum : 1)));
  return radii.map(([x, y]) => [x * factor, y * factor]) as Corners;
}

function roundedRect(x0: number, y0: number, x1: number, y1: number, radii: Corners): string {
  const [tl, tr, br, bl] = fitRadii(radii, x1 - x0, y1 - y0).map(([x, y]) => [round(x), round(y)]);
  const arc = ([rx, ry]: number[], x: number, y: number) => `A ${rx} ${ry} 0 0 1 ${round(x)} ${round(y)}`;
  return [
    `M ${round(x0 + tl[0])} ${round(y0)}`,
    `H ${round(x1 - tr[0])}`, arc(tr, x1, y0 + tr[1]),
    `V ${round(y1 - br[1])}`, arc(br, x1 - br[0], y1),
    `H ${round(x0 + bl[0])}`, arc(bl, x0, y1 - bl[1]),
    `V ${round(y0 + tl[1])}`, arc(tl, x0 + tl[0], y0),
    "Z",
  ].join(" ");
}

/** The even-odd clip that keeps exactly what `mask: linear-gradient(#000 0 0)
    content-box, linear-gradient(#000 0 0); mask-composite: exclude` keeps: the
    border box minus the content box, whose corners curve with the outer radii
    less the inset on each side, as a content-box background clip does. */
export function ringClipPath(box: RingBox): string {
  const { width, height, inset } = box;
  const [tl, tr, br, bl] = fitRadii(box.radii, width, height);
  const inner: Corners = [
    [Math.max(0, tl[0] - inset.left), Math.max(0, tl[1] - inset.top)],
    [Math.max(0, tr[0] - inset.right), Math.max(0, tr[1] - inset.top)],
    [Math.max(0, br[0] - inset.right), Math.max(0, br[1] - inset.bottom)],
    [Math.max(0, bl[0] - inset.left), Math.max(0, bl[1] - inset.bottom)],
  ];
  const outer = roundedRect(0, 0, width, height, [tl, tr, br, bl]);
  const hole = roundedRect(inset.left, inset.top, width - inset.right, height - inset.bottom, inner);
  return `path(evenodd, "${outer} ${hole}")`;
}

type MaskedSurface = { token: string; pseudo: "" | "::before" | "::after"; ring: RingBox | null; label: string };

/** Chrome prints `mask-composite: exclude` as a plain union of its layers, and
    pdftocairo writes every soft mask as an opaque image, so a gradient ring cut
    out by a mask (the ribbon role frames, the orchestrator bar) comes out of
    the vector frame as a filled box over the content it frames. For the print
    only, each such ring is drawn by an even-odd clip-path on the same geometry,
    which both steps carry as a vector clip; the live page and its PNG keep the
    product's own CSS, and the render-back comparison checks that the two agree.
    Returns the masks that are not rings, which stay as they are. */
export async function unmaskRingsForPrint(page: Page): Promise<{ rings: number; otherMasks: string[] }> {
  const surfaces: MaskedSurface[] = await page.evaluate(() => {
    const found: MaskedSurface[] = [];
    const px = (value: string) => Number.parseFloat(value) || 0;
    const radius = (value: string, width: number, height: number): [number, number] => {
      const parts = value.trim().split(/\s+/);
      const resolve = (part: string, side: number) => (part.endsWith("%") ? (px(part) / 100) * side : px(part));
      return [resolve(parts[0] ?? "0", width), resolve(parts[1] ?? parts[0] ?? "0", height)];
    };
    let next = 0;
    for (const element of Array.from(document.querySelectorAll<HTMLElement>("*"))) {
      for (const pseudo of ["", "::before", "::after"] as const) {
        const style = getComputedStyle(element, pseudo || null);
        if (pseudo && (style.content === "none" || style.content === "normal")) continue;
        if (style.display === "none") continue;
        const image = style.maskImage && style.maskImage !== "none" ? style.maskImage : style.webkitMaskImage;
        if (!image || image === "none") continue;
        const token = `r${next++}`;
        element.dataset.captureMask = `${element.dataset.captureMask ?? ""} ${token}`.trim();
        const composite = `${style.maskComposite} ${style.webkitMaskComposite}`;
        const clip = style.maskClip || style.webkitMaskClip;
        const label = `${element.tagName.toLowerCase()}${element.className && typeof element.className === "string" ? `.${element.className.trim().split(/\s+/).slice(0, 3).join(".")}` : ""}${pseudo}`;
        if (!/exclude|xor/.test(composite) || !/content-box/.test(clip) || image.split("gradient(").length !== 3) {
          found.push({ token, pseudo, ring: null, label: `${label} (${image.slice(0, 60)})` });
          continue;
        }
        const borderBox = style.boxSizing === "border-box";
        const edges = {
          top: px(style.paddingTop) + px(style.borderTopWidth),
          right: px(style.paddingRight) + px(style.borderRightWidth),
          bottom: px(style.paddingBottom) + px(style.borderBottomWidth),
          left: px(style.paddingLeft) + px(style.borderLeftWidth),
        };
        const width = pseudo ? px(style.width) + (borderBox ? 0 : edges.left + edges.right) : element.offsetWidth;
        const height = pseudo ? px(style.height) + (borderBox ? 0 : edges.top + edges.bottom) : element.offsetHeight;
        found.push({
          token,
          pseudo,
          label,
          ring: {
            width,
            height,
            inset: edges,
            radii: [
              radius(style.borderTopLeftRadius, width, height),
              radius(style.borderTopRightRadius, width, height),
              radius(style.borderBottomRightRadius, width, height),
              radius(style.borderBottomLeftRadius, width, height),
            ],
          },
        });
      }
    }
    return found;
  });
  const rules = surfaces
    .filter((surface) => surface.ring)
    .map((surface) => `[data-capture-mask~="${surface.token}"]${surface.pseudo} { -webkit-mask: none !important; mask: none !important; clip-path: ${ringClipPath(surface.ring!)} !important; }`);
  if (rules.length) await page.addStyleTag({ content: rules.join("\n") });
  return { rings: rules.length, otherMasks: surfaces.filter((surface) => !surface.ring).map((surface) => surface.label) };
}

/* ── render-back ────────────────────────────────────────────────────────── */

/** A frame's vector is judged against its PNG in square tiles of this many
    device pixels (16 CSS px at the capture's scale of 2): a defect as small as
    one mis-painted chip fills a tile, where a frame-wide average would dilute
    it below any threshold that glyph antialiasing also stays under. */
export const RENDER_BACK_TILE = 32;
/** The largest mean per-pixel difference (the larger of the three channel
    differences, 0–255) any tile may show. Glyphs drawn as paths and as text,
    and gradients sampled by two rasterizers, stay well below it; a filled box
    where a ring belongs, a lost mask or a missing element does not. */
export const RENDER_BACK_TILE_LIMIT = 24;
/** The largest share of tiles that may differ at all (mean above 6). */
export const RENDER_BACK_CHANGED_TILE_SHARE = 0.25;

export type RenderBackVerdict = {
  ok: boolean;
  worstTile: { x: number; y: number; mean: number };
  changedTileShare: number;
  meanDifference: number;
};

/** Judges a per-pixel difference map (one byte per pixel, the largest channel
    difference) between a frame's PNG and its SVG rendered back. */
export function judgeRenderBack(difference: Uint8Array, width: number, height: number, tile = RENDER_BACK_TILE): RenderBackVerdict {
  if (difference.length !== width * height) throw new Error(`difference map holds ${difference.length} pixels, expected ${width * height}`);
  let total = 0;
  let worst = { x: 0, y: 0, mean: 0 };
  let tiles = 0;
  let changed = 0;
  for (let top = 0; top < height; top += tile) {
    for (let left = 0; left < width; left += tile) {
      let sum = 0;
      let count = 0;
      for (let y = top; y < Math.min(top + tile, height); y++) {
        for (let x = left; x < Math.min(left + tile, width); x++) {
          sum += difference[y * width + x]!;
          count++;
        }
      }
      total += sum;
      tiles++;
      const mean = sum / count;
      if (mean > 6) changed++;
      if (mean > worst.mean) worst = { x: left, y: top, mean: round(mean) };
    }
  }
  const changedTileShare = round(changed / tiles);
  return {
    ok: worst.mean <= RENDER_BACK_TILE_LIMIT && changedTileShare <= RENDER_BACK_CHANGED_TILE_SHARE,
    worstTile: worst,
    changedTileShare,
    meanDifference: round(total / (width * height)),
  };
}

/** Opens the SVG the way a README shows it, an <img> at the frame's CSS size,
    and screenshots it at the capture's device scale. */
export async function renderBack(browser: Browser, svg: Buffer, viewport: ReadmeShot["viewport"]): Promise<Buffer> {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 2, colorScheme: "dark" });
  try {
    const page = await context.newPage();
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff"><img id="frame" alt="" width="${viewport.width}" height="${viewport.height}" style="display:block" src="data:image/svg+xml;base64,${svg.toString("base64")}"></body></html>`);
    await page.locator("#frame").evaluate((image: HTMLImageElement) => image.decode());
    return await page.screenshot({ clip: { x: 0, y: 0, ...viewport } });
  } finally {
    await context.close();
  }
}

/** The per-pixel difference between two PNGs of one size, decoded by Chrome,
    and a heat map of it for the evidence directory. */
export async function pixelDifference(browser: Browser, reference: Buffer, candidate: Buffer): Promise<{ width: number; height: number; difference: Uint8Array; heatmap: Buffer }> {
  const context = await browser.newContext();
  try {
    const page = await context.newPage();
    const result = await page.evaluate(async ({ reference, candidate }) => {
      const load = async (base64: string) => {
        const image = new Image();
        image.src = `data:image/png;base64,${base64}`;
        await image.decode();
        const canvas = document.createElement("canvas");
        canvas.width = image.naturalWidth;
        canvas.height = image.naturalHeight;
        const context = canvas.getContext("2d")!;
        context.drawImage(image, 0, 0);
        return context.getImageData(0, 0, canvas.width, canvas.height);
      };
      const [a, b] = [await load(reference), await load(candidate)];
      if (a.width !== b.width || a.height !== b.height) return { error: `${a.width}×${a.height} against ${b.width}×${b.height}` };
      const difference = new Uint8Array(a.width * a.height);
      const heat = new ImageData(a.width, a.height);
      for (let pixel = 0; pixel < difference.length; pixel++) {
        const offset = pixel * 4;
        const value = Math.max(
          Math.abs(a.data[offset]! - b.data[offset]!),
          Math.abs(a.data[offset + 1]! - b.data[offset + 1]!),
          Math.abs(a.data[offset + 2]! - b.data[offset + 2]!),
        );
        difference[pixel] = value;
        const shade = a.data[offset]! * 0.2;
        heat.data[offset] = Math.max(shade, value * 4);
        heat.data[offset + 1] = shade;
        heat.data[offset + 2] = shade;
        heat.data[offset + 3] = 255;
      }
      const canvas = document.createElement("canvas");
      canvas.width = a.width;
      canvas.height = a.height;
      canvas.getContext("2d")!.putImageData(heat, 0, 0);
      let binary = "";
      for (let start = 0; start < difference.length; start += 0x8000) binary += String.fromCharCode(...difference.subarray(start, start + 0x8000));
      return { width: a.width, height: a.height, difference: btoa(binary), heatmap: canvas.toDataURL("image/png").split(",")[1]! };
    }, { reference: reference.toString("base64"), candidate: candidate.toString("base64") });
    if ("error" in result) throw new Error(`render-back size differs from the PNG: ${result.error}`);
    return {
      width: result.width,
      height: result.height,
      difference: new Uint8Array(Buffer.from(result.difference, "base64")),
      heatmap: Buffer.from(result.heatmap, "base64"),
    };
  } finally {
    await context.close();
  }
}

export function sha256(bytes: Buffer | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Strings that identify this machine and must never appear on a committed
    frame. The capture root is not among them: it names nothing, and a
    conversation's off-screen header carries it as the working directory. */
function forbiddenHostText(): string[] {
  const values = [os.homedir(), os.userInfo().username, os.hostname()];
  return values.filter((value) => value && value.length >= 3);
}

/* ── run ────────────────────────────────────────────────────────────────── */

async function main(): Promise<void> {
  const repoRoot = path.resolve(import.meta.dir, "..");
  /* A fresh directory this run owns; nothing that existed before is cleared. */
  const captureRoot = createCaptureDirectory({
    envName: "LLV_README_CAPTURE_ROOT",
    prefix: "llv-readme",
    raw: process.env.LLV_README_CAPTURE_ROOT,
    repoRoot,
    tempRoot: SCRATCH_ROOT,
  });
  process.stdout.write(`capture root ${captureRoot}\n`);
  const env = buildCaptureEnvironment(captureRoot);
  const now = Date.now();
  const layout = await materialize(env, now);

  const port = await freePort();
  const server = spawn(
    process.execPath,
    ["--bun", path.join(repoRoot, "node_modules/.bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: repoRoot, env, stdio: ["ignore", "pipe", "pipe"] },
  );
  const serverPid = server.pid;
  fs.writeFileSync(path.join(captureRoot, "server.pid"), `${serverPid}\n`);
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
    await captureShots(repoRoot, baseUrl, layout, captureRoot);
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

async function captureShots(repoRoot: string, baseUrl: string, layout: Layout, captureRoot: string): Promise<void> {
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
      /* Runs at real time until the frame is frozen below. */
      await page.clock.install();
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
      /* The print is taken seconds after the PNG, and a live timer or a
         pulsing dot would read differently in each: stop the page's clock and
         every animation where they stand, so both show one frame. */
      await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1_000));
      await page.evaluate(() => {
        for (const animation of document.getAnimations()) animation.pause();
      });
      await page.waitForTimeout(300);

      const text = await page.evaluate(() => document.body.innerText);
      for (const required of shot.requiredText) {
        if (!text.includes(required)) throw new Error(`${shot.id}: missing text ${JSON.stringify(required)}`);
      }
      for (const absent of [...(shot.absentText ?? []), ...forbidden]) {
        if (text.includes(absent)) throw new Error(`${shot.id}: frame shows ${JSON.stringify(absent)}`);
      }

      const textFindings = [...sensitiveClasses(text)];
      if (textFindings.length) throw new Error(`${shot.id}: the gate classifies the frame text as ${textFindings.join(", ")}`);

      const png = path.join(EVIDENCE_DIR, `${shot.id}.png`);
      const frame = await page.screenshot({ path: png });
      /* A browser raster never carries provenance, so those two classes are
         expected here; anything else the gate finds in the pixels is not. */
      const rasterFindings = [...inspectPaths([png]).keys()].filter((finding) => !finding.startsWith("provenance_"));
      if (rasterFindings.length) throw new Error(`${shot.id}: the gate finds ${rasterFindings.join(", ")} in the rendered frame`);
      await page.emulateMedia({ media: "screen", colorScheme: "dark" });
      const unmasked = await unmaskRingsForPrint(page);
      if (unmasked.otherMasks.length) process.stdout.write(`${shot.id}: masks left to the render-back check: ${unmasked.otherMasks.join("; ")}\n`);
      const printOptions = {
        width: `${shot.viewport.width}px`,
        height: `${shot.viewport.height}px`,
        printBackground: true,
        pageRanges: "1",
        margin: { top: "0", bottom: "0", left: "0", right: "0" },
      };
      /* The first print of a page drew the board page behind an open
         conversation 260 px off the scroll offset the screen shows; a second
         print of the same page draws it where the screen has it. The first is
         thrown away, and the render-back comparison judges the one kept. */
      await page.pdf(printOptions);
      const pdf = await page.pdf(printOptions);
      /* The vector is drafted in the capture root and reaches the repository
         only once Chrome, rendering it back as a README shows it, draws what
         the PNG shows. */
      const draft = path.join(captureRoot, `${shot.id}.svg`);
      const rasterTiles = pdfToSvg(Buffer.from(pdf), draft, captureRoot);
      const svg = fs.readFileSync(draft);
      const printed = svg.toString("utf8", 0, 600).match(/<svg\b[^>]*\bwidth="([\d.]+)pt" height="([\d.]+)pt"/);
      const expected = [shot.viewport.width * 0.75, shot.viewport.height * 0.75];
      if (!printed || Math.abs(Number(printed[1]) - expected[0]) > 0.01 || Math.abs(Number(printed[2]) - expected[1]) > 0.01) {
        throw new Error(`${shot.id}: Chrome printed a ${printed?.[1]} × ${printed?.[2]} pt page for a ${expected.join(" × ")} pt frame, which draws the vector at another scale than its PNG; pick a viewport it prints exactly (multiples of 8 px do)`);
      }
      const rendered = await renderBack(browser, svg, shot.viewport);
      fs.writeFileSync(path.join(EVIDENCE_DIR, `${shot.id}.svg.png`), rendered);
      const { width, height, difference, heatmap } = await pixelDifference(browser, frame, rendered);
      fs.writeFileSync(path.join(EVIDENCE_DIR, `${shot.id}.diff.png`), heatmap);
      const renderBackVerdict = judgeRenderBack(difference, width, height);
      if (!renderBackVerdict.ok) {
        throw new Error(`${shot.id}: the SVG rendered back differs from its PNG (worst tile at ${renderBackVerdict.worstTile.x},${renderBackVerdict.worstTile.y} device px, mean ${renderBackVerdict.worstTile.mean} over the limit ${RENDER_BACK_TILE_LIMIT}; ${renderBackVerdict.changedTileShare} of tiles changed); see ${draft} and ${EVIDENCE_DIR}/${shot.id}.diff.png`);
      }
      const svgPath = path.join(repoRoot, README_MEDIA_DIR, `${shot.id}.svg`);
      fs.mkdirSync(path.dirname(svgPath), { recursive: true });
      fs.writeFileSync(svgPath, svg);
      manifest.push({
        path: `${shot.id}.svg`,
        description: shot.description,
        viewport: shot.viewport,
        colorScheme: "dark",
        rasterTiles,
        renderBack: { worstTileMean: renderBackVerdict.worstTile.mean, changedTileShare: renderBackVerdict.changedTileShare, meanDifference: renderBackVerdict.meanDifference, ringsClipped: unmasked.rings },
        sha256: sha256(svg),
      });
      await context.close();
      process.stdout.write(`captured ${shot.id} → ${png} (render-back worst tile ${renderBackVerdict.worstTile.mean}, ${unmasked.rings} rings clipped)\n`);
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
