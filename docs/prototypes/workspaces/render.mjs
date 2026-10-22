// Renders the storyboard frames of this prototype in headless Chromium and
// checks every frame for cut or escaping text before writing it.
//
//   PLAYWRIGHT_CORE=<path to a playwright-core package> CHROME_BIN=<chromium> \
//     node docs/prototypes/workspaces/render.mjs [outDir]
//
// Writes variant-N-<width>-<lang>.png (light) and variant-N-<width>-<lang>-dark.png
// for N = 1..4, widths 1440 and 390, languages en and uk. Pass --widths=820 to
// render an in-between width for a check without touching the committed frames.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const outDir = path.resolve(args.find((a) => !a.startsWith("--")) ?? here);
const widthsArg = args.find((a) => a.startsWith("--widths="));
const widths = widthsArg ? widthsArg.slice(9).split(",").map(Number) : [1440, 390];
const themesArg = args.find((a) => a.startsWith("--themes="));
const themes = themesArg ? themesArg.slice(9).split(",") : ["light", "dark"];
const variantsArg = args.find((a) => a.startsWith("--variants="));
const variants = variantsArg ? variantsArg.slice(11).split(",").map(Number) : [1, 2, 3, 4];
// --state-shots=<dir>: also write one picture per numbered state, for looking at each screen whole.
const shotsArg = args.find((a) => a.startsWith("--state-shots="));
const shotsDir = shotsArg ? path.resolve(shotsArg.slice(14)) : null;

const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_CORE ?? "playwright-core");
// CHROME_TMPDIR: a short temp root for Chromium alone; a long TMPDIR overflows its socket path.
const env = process.env.CHROME_TMPDIR ? { ...process.env, TMPDIR: process.env.CHROME_TMPDIR } : process.env;
const browser = await chromium.launch({ executablePath: process.env.CHROME_BIN || undefined, args: ["--font-render-hinting=none"], env });
let problems = 0;
try {
  for (const v of variants) {
    for (const width of widths) {
      for (const lang of ["en", "uk"]) {
        for (const theme of themes) {
          const page = await browser.newPage({ viewport: { width, height: 900 }, deviceScaleFactor: 1 });
          const url = `${pathToFileURL(path.join(here, `variant-${v}.html`)).href}?story&lang=${lang}&theme=${theme}`;
          await page.goto(url);
          await page.evaluate(() => document.fonts.ready);
          await page.waitForFunction(() => [...document.images].every((img) => img.complete));
          const report = await page.evaluate(() => {
            const out = [];
            for (const screen of document.querySelectorAll(".screen")) {
              const box = screen.getBoundingClientRect();
              const walker = document.createTreeWalker(screen, NodeFilter.SHOW_TEXT);
              for (let node = walker.nextNode(); node; node = walker.nextNode()) {
                if (!node.textContent.trim()) continue;
                const el = node.parentElement;
                const cs = getComputedStyle(el);
                if (cs.visibility === "hidden" || cs.opacity === "0" || el.closest(".sr")) continue;
                const range = document.createRange();
                range.selectNodeContents(node);
                for (const r of range.getClientRects()) {
                  if (r.width === 0) continue;
                  if (r.left < box.left - 0.5 || r.right > box.right + 0.5 || r.bottom > box.bottom + 0.5) out.push(`state ${screen.dataset.state}: text leaves the screen: «${node.textContent.trim().slice(0, 60)}»`);
                  // Clipped by an overflow-hidden ancestor inside the screen.
                  for (let a = el; a && a !== screen; a = a.parentElement) {
                    const acs = getComputedStyle(a);
                    if (acs.overflow === "visible" && acs.overflowX === "visible" && acs.overflowY === "visible") continue;
                    const ab = a.getBoundingClientRect();
                    if (r.right > ab.right + 0.5 || r.bottom > ab.bottom + 0.5 || r.left < ab.left - 0.5 || r.top < ab.top - 0.5) {
                      out.push(`state ${screen.dataset.state}: text cut by ${a.className || a.tagName}: «${node.textContent.trim().slice(0, 60)}»`);
                      break;
                    }
                  }
                }
              }
              // Truncated single-line labels.
              for (const el of screen.querySelectorAll("*")) {
                const cs = getComputedStyle(el);
                if (cs.textOverflow === "ellipsis" && el.scrollWidth > el.clientWidth + 1) out.push(`state ${screen.dataset.state}: ellipsis on «${el.textContent.trim().slice(0, 60)}»`);
              }
              // Commands are copied and read: no token of a command block is split across lines.
              for (const block of screen.querySelectorAll(".code")) {
                const w = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
                for (let node = w.nextNode(); node; node = w.nextNode()) {
                  for (const m of node.textContent.matchAll(/\S+/g)) {
                    const range = document.createRange();
                    range.setStart(node, m.index);
                    range.setEnd(node, m.index + m[0].length);
                    const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
                    if (tops.size > 1) out.push(`state ${screen.dataset.state}: command token split across lines: «${m[0]}»`);
                    // A line-continuation backslash stays on the line it continues.
                    if (m[0] === "\\" && m.index > 0) {
                      const prev = document.createRange();
                      prev.setStart(node, m.index - 1);
                      prev.setEnd(node, m.index);
                      const [a] = prev.getClientRects(), [b] = range.getClientRects();
                      if (a && b && Math.round(a.top) !== Math.round(b.top)) out.push(`state ${screen.dataset.state}: continuation backslash wrapped onto its own line`);
                    }
                  }
                }
              }
              // Inline identifiers (a computer user, a folder) stay whole on one line.
              for (const el of screen.querySelectorAll(".mono")) {
                if (el.closest(".code")) continue;
                const range = document.createRange();
                range.selectNodeContents(el);
                const tops = new Set([...range.getClientRects()].filter((r) => r.width > 0).map((r) => Math.round(r.top)));
                if (tops.size > 1) out.push(`state ${screen.dataset.state}: inline identifier split across lines: «${el.textContent.trim()}»`);
              }
              // One-line labels: switcher rows and the role control's subtitles.
              for (const el of screen.querySelectorAll(".pop .mrow, .indent .srw, .seg .sub")) {
                const mids = [];
                const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
                for (let node = w.nextNode(); node; node = w.nextNode()) {
                  if (!node.textContent.trim()) continue;
                  const range = document.createRange();
                  range.selectNodeContents(node);
                  for (const r of range.getClientRects()) if (r.width > 0) mids.push(r.top + r.height / 2);
                }
                if (mids.length && Math.max(...mids) - Math.min(...mids) > 6) out.push(`state ${screen.dataset.state}: wraps to more than one line: «${el.textContent.trim().slice(0, 60)}»`);
              }
              // Popovers, menus and dialogs stay inside the screen.
              for (const el of screen.querySelectorAll(".pop, .dlg, .sheet")) {
                const r = el.getBoundingClientRect();
                if (r.left < box.left || r.right > box.right + 0.5 || r.bottom > box.bottom + 0.5 || r.top < box.top) out.push(`state ${screen.dataset.state}: ${el.className} leaves the screen`);
              }
            }
            return [...new Set(out)];
          });
          const name = `variant-${v}-${width}-${lang}${theme === "dark" ? "-dark" : ""}.png`;
          if (report.length) {
            problems += report.length;
            console.log(`${name}\n  ${report.join("\n  ")}`);
          }
          await page.screenshot({ path: path.join(outDir, name), fullPage: true });
          if (shotsDir) {
            const screens = await page.$$(".screen");
            for (const el of screens) await el.screenshot({ path: path.join(shotsDir, `v${v}-${width}-${lang}-${theme}-s${await el.getAttribute("data-state")}.png`) });
          }
          const size = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.scrollHeight]);
          console.log(`wrote ${name} ${size.join("x")}`);
          await page.close();
        }
      }
    }
  }
} finally {
  await browser.close();
}
if (problems) {
  console.log(`${problems} layout problems`);
  process.exitCode = 1;
}
