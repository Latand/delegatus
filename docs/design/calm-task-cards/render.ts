/*
 * Renders the calm-task-cards prototype through the kanban evidence harness
 * (`serveEvidenceFixture`, `openFixture`): the original cards and the three
 * variants, closed on the board and opened, at 1440 and 390, uk and en, light
 * and dark. Frames go to `CC_OUT` (default /var/tmp/calm-task-cards) as
 * `variant-N-<w>-<lang>-<theme>-<frame>-original|changed.png`; the measured
 * geometry goes to `geometry.json` beside this file.
 *
 *   CHROME_BIN=<chrome> bun docs/design/calm-task-cards/render.ts [w=390] [variant=1] [frame=open] [lang=uk] [theme=dark]
 *
 * Run it from the repository root. A filter narrows the matrix; a filtered
 * run merges its scenes into the geometry already written.
 */
import fs from "node:fs";
import path from "node:path";
import tailwind from "@tailwindcss/postcss";
import { chromium, type Browser, type Page } from "playwright-core";
import postcss from "postcss";

import { openFixture, serveEvidenceFixture } from "../../../src/components/kanban/issue1695BrowserHarness";

const HERE = path.dirname(new URL(import.meta.url).pathname);
const OUT = process.env.CC_OUT ?? "/var/tmp/calm-task-cards";
const GEOMETRY = path.join(HERE, "geometry.json");
const filter = Object.fromEntries(process.argv.slice(2).map((arg) => arg.split("=") as [string, string]));

const WIDTHS = [1440, 390] as const;
const LANGS = ["uk", "en"] as const;
const THEMES = ["light", "dark"] as const;
const FRAMES = ["board", "open"] as const;
const VARIANTS = [0, 1, 2, 3] as const;

type Scene = { w: number; lang: string; theme: "light" | "dark"; frame: string; variant: number };
const scenes: Scene[] = [];
for (const w of WIDTHS) for (const lang of LANGS) for (const theme of THEMES) for (const frame of FRAMES) for (const variant of VARIANTS) {
  const scene = { w, lang, theme, frame, variant };
  if (Object.entries(filter).every(([key, value]) => String(scene[key as keyof Scene]) === value)) scenes.push(scene);
}

/* The production stylesheet, compiled with this folder as one more source,
   then the prototype's own rules. */
async function stylesheet(): Promise<string> {
  const globals = path.resolve("src/app/globals.css");
  const source = fs.readFileSync(globals, "utf8").replace(/(@import "tailwindcss"[^;]*;)/, `$1\n@source "${path.relative(path.dirname(globals), HERE)}";`);
  const css = await postcss([tailwind()]).process(source, { from: globals });
  return `${css.css}\n${fs.readFileSync(path.join(HERE, "calm.css"), "utf8")}`;
}

/* What a frame shows, measured: overflow (integer and fractional, and
   whether the page pans), every closed card's buttons, cut lines, the dot,
   the popover, and the phone's tap targets. */
async function measure(page: Page, scene: Scene) {
  return page.evaluate(({ width, phone }) => {
    const scroller = document.scrollingElement!;
    scroller.scrollLeft = 10_000;
    const pans = scroller.scrollLeft;
    scroller.scrollLeft = 0;
    const box = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return { x: Math.round(rect.x * 10) / 10, y: Math.round(rect.y * 10) / 10, w: Math.round(rect.width * 10) / 10, h: Math.round(rect.height * 10) / 10 };
    };
    const shown = (element: Element) => {
      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && getComputedStyle(element).visibility !== "hidden";
    };
    /* A line is cut when its text's own extent passes its box. */
    const cut = (element: Element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      const own = element.getBoundingClientRect();
      return text.right > own.right + 0.5 || text.bottom > own.bottom + 0.5;
    };
    let widest = 0;
    for (const element of document.querySelectorAll("body *")) widest = Math.max(widest, element.getBoundingClientRect().right);
    const cards = [...document.querySelectorAll<HTMLElement>("[data-cc-card]")].map((card) => {
      const buttons = [...card.querySelectorAll<HTMLElement>(".cc-act, .cc-link, .cc-menu-item")].filter(shown);
      const dot = card.querySelector(".cc-dot");
      const pop = card.querySelector(".cc-pop");
      const line = card.querySelector(".cc-line-text");
      const answer = card.querySelector(".cc-answer");
      const lineBox = line ? line.getBoundingClientRect() : null;
      const answerBox = answer ? answer.getBoundingClientRect() : null;
      return {
        id: card.dataset.ccCard, owner: card.dataset.ccOwner, state: card.dataset.ccState, box: box(card),
        buttons: buttons.map((button) => ({ text: button.textContent?.trim(), ...box(button) })),
        smallTargets: phone ? buttons.filter((button) => button.getBoundingClientRect().height < 43.5).map((button) => button.textContent?.trim()) : [],
        dot: dot ? Number.parseFloat(getComputedStyle(dot, "::before").width) : null,
        pop: pop && shown(pop) ? { ...box(pop), inside: pop.getBoundingClientRect().right <= width + 0.5 && pop.getBoundingClientRect().left >= -0.5 } : null,
        cutTitle: card.querySelector("[data-cc-title]") ? cut(card.querySelector("[data-cc-title]")!) : null,
        cutLine: line ? cut(line) : null,
        lineAnswerOverlap: lineBox && answerBox ? Math.max(0, Math.min(lineBox.right, answerBox.right) - Math.max(lineBox.left, answerBox.left)) * (lineBox.bottom > answerBox.top && answerBox.bottom > lineBox.top ? 1 : 0) : 0,
      };
    });
    const original = {
      answerButtons: [...document.querySelectorAll("[data-answer-action]")].filter(shown).map((button) => button.textContent?.trim()),
      dismissButtons: [...document.querySelectorAll("[data-dismiss]")].filter(shown).length,
      needsCards: document.querySelectorAll('[data-attention="needs"]').length,
      warningReasons: [...document.querySelectorAll(".pb-answer .stage-report, .pb-reason")].filter(shown).map((line) => line.textContent?.trim().slice(0, 120)),
      cardHeights: [...document.querySelectorAll("[data-kanban-card], [data-phone-card]")].filter(shown).map((card) => Math.round(card.getBoundingClientRect().height)),
    };
    return {
      width, scrollWidth: scroller.scrollWidth, pans, widestRight: Math.round(widest * 10) / 10,
      overflowX: Math.max(0, Math.round((widest - width) * 10) / 10),
      height: scroller.scrollHeight, cards, original,
    };
  }, { width: scene.w, phone: scene.w < 700 });
}

const name = (scene: Scene, side: "original" | "changed", variant = scene.variant) => `variant-${variant}-${scene.w}-${scene.lang}-${scene.theme}-${scene.frame}-${side}.png`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const css = await stylesheet();
  const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "calm-cards-"));
  const server = await serveEvidenceFixture(scratch, path.join(HERE, "fixture.tsx"), {
    "/style.css": () => new Response(css, { headers: { "content-type": "text/css" } }),
  });
  const executablePath = process.env.CHROME_BIN;
  let browser: Browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
  const previous = fs.existsSync(GEOMETRY) ? JSON.parse(fs.readFileSync(GEOMETRY, "utf8")) as Record<string, unknown> : {};
  const geometry: Record<string, unknown> = { ...previous };
  const errors: string[] = [];
  try {
    for (const scene of scenes) {
      if (!browser.isConnected()) browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
      const phone = scene.w < 700;
      const url = `${server.base}?frame=${scene.frame}&variant=${scene.variant}&w=${scene.w}`;
      const { context, page, pageErrors } = await openFixture(browser, url, { width: scene.w, height: phone ? 844 : 900 }, scene.theme, scene.lang as "en" | "uk", "reduce", phone);
      try {
        await page.waitForSelector("[data-fr-band]", { timeout: 30_000 });
        await page.waitForFunction(() => document.fonts.status === "loaded");
        await page.waitForTimeout(400);
        const side = scene.variant === 0 ? "original" : "changed";
        const file = path.join(OUT, scene.variant === 0 ? `original-${scene.w}-${scene.lang}-${scene.theme}-${scene.frame}.png` : name(scene, "changed"));
        await page.screenshot({ path: file, fullPage: true });
        if (scene.variant === 0) for (const variant of [1, 2, 3]) fs.copyFileSync(file, path.join(OUT, name(scene, "original", variant)));
        const key = `${scene.variant}|${scene.w}|${scene.lang}|${scene.theme}|${scene.frame}`;
        geometry[key] = { side, file: path.basename(file), ...(await measure(page, scene)), pageErrors };
        if (pageErrors.length) errors.push(`${key}: ${pageErrors.join(" | ")}`);
        console.log(`${key} ok`);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser.close();
    server.stop();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
  fs.writeFileSync(GEOMETRY, `${JSON.stringify(Object.fromEntries(Object.entries(geometry).sort(([a], [b]) => a.localeCompare(b))), null, 1)}\n`);
  if (errors.length) console.log(`page errors:\n${errors.join("\n")}`);
}

await main();
