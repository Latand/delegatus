/*
 * Renders the Part A variants of docs/design/prototype-reject-and-critic-gate.md
 * through the existing kanban fixture (`?proto=1`) and harness, on an export
 * patched by patch.ts. Run from the export's root:
 *
 *   CHROME_BIN=<chrome wrapper> REJECT_FRAMES=<evidence dir> \
 *     bun docs/design/prototype-reject-prototype/render.ts
 *
 * Writes `variant-N-<width>-<lang>-<theme>-<state>[-changed|-original].png`
 * into REJECT_FRAMES, each with a printed band naming its variant, and the
 * measured geometry to geometry.json beside this file.
 */
import fs from "node:fs";
import path from "node:path";
import { chromium, type Page } from "playwright-core";
import sharp from "sharp";

import { openFixture, serveEvidenceFixture } from "@/components/kanban/issue1695BrowserHarness";

const OUT = path.resolve(process.env.REJECT_FRAMES ?? "");
const SCRATCH = path.resolve(process.env.REJECT_SCRATCH ?? path.join(process.env.TMPDIR ?? "/tmp", "reject-fixture"));
fs.mkdirSync(OUT, { recursive: true });
fs.mkdirSync(SCRATCH, { recursive: true });

const VARIANTS = [
  { n: 1, name: "Окрема кнопка" },
  { n: 2, name: "Перемикач «Обрати / Переробити»" },
  { n: 3, name: "«Жоден не підходить» у рядку вибору" },
] as const;
const VIEWPORTS = [{ width: 1440, height: 900, phone: false }, { width: 390, height: 844, phone: true }] as const;
const STATES = ["rest", "picked", "pickedtext", "armed", "asks", "rejected"] as const;
type State = (typeof STATES)[number];
const STATE_WORDS: Record<State, string> = { rest: "відкрито", picked: "варіант 1 обрано, поле порожнє", pickedtext: "варіант 1 обрано, текст написано", armed: "поправки написано", asks: "відхилення без поправок", rejected: "після відхилення" };
const PAIRED: readonly State[] = ["rest", "armed"];
/* The ordinary choose path beside the new control: variant 1 of the round is ticked. */
const PICKED: readonly State[] = ["picked", "pickedtext"];
/* REJECT_ONLY=<pattern> renders the frames whose key matches, and merges their geometry into the file. */
const ONLY = process.env.REJECT_ONLY ? new RegExp(process.env.REJECT_ONLY) : null;
const CORRECTIONS = {
  uk: "Усі чотири перевантажені. Потрібен один простий список без карток: назва, шлях і дата; відкритий результат праворуч.",
  en: "All four are cluttered. One plain list with no cards: name, path and date, with the opened result on the right.",
};
const COMMENT = {
  uk: "Беру перший, але шлях зробіть сірим і дрібнішим за назву.",
  en: "Taking the first one, but make the path grey and smaller than the name.",
};

/* The band printed over each frame: the variant's number and name, the viewport, the language, the theme, the state.
   A phone frame is too narrow for one line, so its band breaks after the variant's name. */
async function band(file: string, words: string, scheme: "light" | "dark") {
  const image = sharp(file);
  const { width = 0 } = await image.metadata();
  const lines = width < 600 ? words.split(" — ") : [words];
  const size = width < 600 ? 14 : 16;
  const height = 12 + lines.length * (size + 6);
  const [bg, fg] = scheme === "dark" ? ["#f2f2f5", "#14141c"] : ["#14141c", "#f2f2f5"];
  const escape = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  const text = lines.map((line, at) => `<text x="12" y="${6 + (at + 1) * (size + 6) - 4}" font-family="sans-serif" font-size="${size}" font-weight="700" fill="${fg}">${escape(line)}</text>`).join("");
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><rect width="100%" height="100%" fill="${bg}"/>${text}</svg>`;
  const out = await image.extend({ top: height, background: bg }).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).png({ compressionLevel: 9 }).toBuffer();
  fs.writeFileSync(file, out);
}

/* What the footer draws: its controls, whether any two overlap, whether a label is cut, and any sideways scroll. */
function measure(page: Page, phone: boolean) {
  return page.evaluate((onPhone) => {
    const round = (value: number) => Math.round(value * 10) / 10;
    const footer = onPhone ? document.querySelector<HTMLElement>("[data-mobile2-sheet=prototype-review] > :last-child") : document.querySelector<HTMLElement>("[data-prototype-review] [role=dialog] > footer");
    const canvas = document.querySelector<HTMLElement>("[data-prototype-canvas]");
    const controls = [...(footer?.querySelectorAll<HTMLElement>("button, textarea") ?? [])].filter((element) => element.getBoundingClientRect().width > 0);
    const boxes = controls.map((element) => {
      const box = element.getBoundingClientRect();
      const range = document.createRange();
      range.selectNodeContents(element);
      const text = range.getBoundingClientRect();
      const style = getComputedStyle(element);
      const inner = box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight);
      return {
        what: element.dataset.prototypeRejectMode ? `mode-${element.dataset.prototypeRejectMode}` : Object.keys(element.dataset).find((key) => key.startsWith("prototype")) ?? element.tagName.toLowerCase(),
        label: element.tagName === "TEXTAREA" ? null : (element.textContent ?? "").trim(),
        box: [round(box.left), round(box.top), round(box.width), round(box.height)],
        cut: element.tagName !== "TEXTAREA" && text.width > inner + 0.5,
        lines: element.tagName === "TEXTAREA" ? null : Math.round(text.height / parseFloat(style.lineHeight || "16")),
        onScreen: box.left >= -0.5 && box.right <= innerWidth + 0.5 && box.top >= -0.5 && box.bottom <= innerHeight + 0.5,
        disabled: (element as HTMLButtonElement).disabled ?? false,
      };
    });
    const overlaps: string[] = [];
    for (let i = 0; i < boxes.length; i += 1) for (let j = i + 1; j < boxes.length; j += 1) {
      const [a, b] = [boxes[i]!.box, boxes[j]!.box];
      if (a[0]! < b[0]! + b[2]! - 0.5 && b[0]! < a[0]! + a[2]! - 0.5 && a[1]! < b[1]! + b[3]! - 0.5 && b[1]! < a[1]! + a[3]! - 0.5) overlaps.push(`${boxes[i]!.what} × ${boxes[j]!.what}`);
    }
    let sideways = 0;
    if (footer) { footer.scrollLeft = 10_000; sideways = footer.scrollLeft; footer.scrollLeft = 0; }
    const primaries = [...(footer?.querySelectorAll<HTMLElement>("[data-prototype-save]") ?? [])].length;
    const rect = (selector: string) => {
      const box = document.querySelector<HTMLElement>(selector)?.getBoundingClientRect();
      return box && box.width > 0 ? { left: round(box.left), top: round(box.top), right: round(box.right), bottom: round(box.bottom) } : null;
    };
    /* The line that names the task: the sheet's context line on the phone, the dialog's subtitle on the desktop. */
    const taskLine = (onPhone ? document.querySelector("[data-prototype-context-line]") : document.querySelector("[data-prototype-review] [role=dialog] header p"))?.textContent ?? "";
    const none = document.querySelector<HTMLElement>("[data-prototype-reject-none]");
    const before = none?.previousElementSibling?.getBoundingClientRect();
    const chosenWord = none?.parentElement?.firstElementChild?.getBoundingClientRect();
    const actionMiddles = [...document.querySelectorAll<HTMLElement>("[data-prototype-actions] > button")].map((element) => round(element.getBoundingClientRect().top + element.getBoundingClientRect().height / 2));
    return {
      footer: footer ? [round(footer.getBoundingClientRect().top), round(footer.getBoundingClientRect().height)] : null,
      canvasHeight: canvas ? round(canvas.getBoundingClientRect().height) : null,
      controls: boxes, overlaps, sideways, primaries, taskLine,
      needsText: rect("[data-prototype-needs-text]"), fieldBox: rect("[data-prototype-field-box]"), actions: rect("[data-prototype-actions]"),
      placeholder: document.querySelector<HTMLTextAreaElement>("[data-prototype-comment-field]")?.placeholder ?? null,
      micColor: (() => { const mic = document.querySelector("[data-prototype-mic] button"); return mic ? getComputedStyle(mic).color : null; })(),
      /* Whether the save is drawn filled: an unavailable save must not be the brightest control in variant 1. */
      saveFilled: (() => { const save = document.querySelector("[data-prototype-save]"); return save ? !/rgba\(0, 0, 0, 0\)|transparent/.test(getComputedStyle(save).backgroundColor) : null; })(),
      textColor: (() => { const field = document.querySelector("[data-prototype-comment-field]"); return field ? getComputedStyle(field).color : null; })(),
      /* The save beside the rejection: whether it can be pressed, and the two fills. */
      saveDisabled: document.querySelector<HTMLButtonElement>("[data-prototype-save]")?.disabled ?? null,
      saveBackground: (() => { const save = document.querySelector("[data-prototype-save]"); return save ? getComputedStyle(save).backgroundColor : null; })(),
      rejectBackground: (() => { const reject = document.querySelector("[data-prototype-reject]"); return reject ? getComputedStyle(reject).backgroundColor : null; })(),
      chosenChips: [...(footer?.querySelectorAll<HTMLElement>("[data-prototype-chosen]") ?? [])].filter((element) => element.getBoundingClientRect().width > 0).length,
      chosenCut: [...(footer?.querySelectorAll<HTMLElement>("[data-prototype-chosen] > :last-child") ?? [])].some((element) => element.scrollWidth > element.clientWidth),
      noneLine: document.querySelector("[data-prototype-none-line]")?.textContent ?? null,
      choosable: [...document.querySelectorAll<HTMLButtonElement>("[data-prototype-choose]")].filter((element) => !element.disabled && element.getBoundingClientRect().width > 0).length,
      actionRows: new Set(actionMiddles).size,
      /* Variant 3: how far the toggle stands from the words before it, and whether it shares the «Chosen» row. */
      noneGap: none && before ? round(none.getBoundingClientRect().left - before.right) : null,
      noneSameRow: none && chosenWord ? Math.abs((none.getBoundingClientRect().top + none.getBoundingClientRect().bottom) / 2 - (chosenWord.top + chosenWord.bottom) / 2) < 12 : null,
      cut: boxes.filter((entry) => entry.cut).map((entry) => entry.what),
      offScreen: boxes.filter((entry) => !entry.onScreen).map((entry) => entry.what),
    };
  }, phone);
}

const server = await serveEvidenceFixture(SCRATCH);
const launched = await chromium.launchServer({ executablePath: process.env.CHROME_BIN, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const pid = launched.process().pid;
fs.writeFileSync(path.join(SCRATCH, "browser-pid"), String(pid));
const browser = await chromium.connect(launched.wsEndpoint());
const geometry: Record<string, unknown> = {};
const failures: string[] = [];
try {
  for (const viewport of VIEWPORTS) for (const lang of ["uk", "en"] as const) for (const scheme of ["light", "dark"] as const) {
    for (const variant of [0, 1, 2, 3]) for (const state of STATES) {
      if (variant === 0 && !PAIRED.includes(state)) continue;
      if (ONLY && !ONLY.test(variant === 0 ? `today-${viewport.width}-${lang}-${scheme}-${state}` : `variant-${variant}-${viewport.width}-${lang}-${scheme}-${state}`)) continue;
      const { context, page, pageErrors } = await openFixture(browser, `${server.base}?proto=1`, { width: viewport.width, height: viewport.height }, scheme, lang, "reduce", viewport.phone);
      try {
        await context.route("**/api/operator/settings", (route) => route.fulfill({ json: { locale: { value: lang, source: "chosen" }, timeZone: null } }));
        await page.evaluate((n) => { (globalThis as { __rejectVariant?: number }).__rejectVariant = n; }, variant);
        if (viewport.phone) {
          await page.waitForSelector("[data-phone-kanban]", { timeout: 30_000 });
          const tab = page.locator('[data-phone-kanban-tab="assigned"]');
          if (await tab.count()) await tab.first().click();
          await page.waitForTimeout(300);
          const open = page.locator('[data-phone-card-prototype-button="t-search"]');
          await open.scrollIntoViewIfNeeded();
          await open.click();
        } else {
          await page.waitForSelector("[data-prototype-button]", { state: "attached", timeout: 30_000 });
          const tab = page.locator('.tabs-nav [data-tab="assigned"]');
          if (await tab.count() && await tab.first().isVisible()) await tab.first().click();
          await page.waitForTimeout(300);
          const open = page.locator('[data-prototype-button="t-search"]');
          await open.scrollIntoViewIfNeeded();
          await open.click();
        }
        await page.waitForSelector("[data-prototype-review] [data-prototype-variant]", { timeout: 15_000 });
        await page.waitForFunction(() => [...document.querySelectorAll<HTMLImageElement>("[data-prototype-canvas] img")].every((image) => image.complete && image.naturalWidth > 0));
        if (PICKED.includes(state)) {
          await page.locator("[data-prototype-choose]:visible").first().click();
          if (state === "pickedtext") {
            await page.locator("[data-prototype-comment-field]").fill(COMMENT[lang]);
            await page.locator("[data-prototype-comment-field]").blur();
          }
        } else if (state !== "rest") {
          if (variant === 2) await page.locator('[data-prototype-reject-mode="redo"]').click();
          if (variant === 3) await page.locator("[data-prototype-reject-none]").click();
          if (state !== "asks") await page.locator("[data-prototype-comment-field]").fill(CORRECTIONS[lang]);
          if (state === "asks" || state === "rejected") {
            await page.evaluate(() => { (window as unknown as { protoSavePhase?: string }).protoSavePhase = "delivered"; });
            await page.locator(variant === 1 ? "[data-prototype-reject]" : "[data-prototype-save]").click();
            await page.waitForSelector(state === "asks" ? "[data-prototype-needs-text]" : "[data-prototype-rejected]", { timeout: 10_000 });
          }
          if (state !== "rejected") await page.locator("[data-prototype-comment-field]").blur();
        }
        await page.waitForTimeout(250);
        const name = variant === 0 ? null : `variant-${variant}-${viewport.width}-${lang}-${scheme}-${state}${PAIRED.includes(state) ? "-changed" : ""}`;
        const reading = await measure(page, viewport.phone);
        const key = name ?? `today-${viewport.width}-${lang}-${scheme}-${state}`;
        geometry[key] = { ...reading, pageErrors };
        if (variant !== 0) {
          if (reading.overlaps.length) failures.push(`${key}: overlapping controls ${reading.overlaps.join(", ")}`);
          if (reading.cut.length) failures.push(`${key}: cut labels ${reading.cut.join(", ")}`);
          if (reading.offScreen.length) failures.push(`${key}: controls off screen ${reading.offScreen.join(", ")}`);
          if (reading.sideways > 0) failures.push(`${key}: the footer scrolls sideways by ${reading.sideways}px`);
          if (reading.primaries !== 1 && state !== "rejected") failures.push(`${key}: ${reading.primaries} primary actions`);
          /* The critic's findings, each as a measured check. */
          if (lang === "uk" && /[A-Za-z]{3,}/.test(reading.taskLine)) failures.push(`${key}: the task line holds English words: ${reading.taskLine}`);
          if (state === "asks") {
            const { needsText, fieldBox, actions } = reading;
            if (!needsText || !fieldBox || !actions) failures.push(`${key}: the «write first» words or the field were not found`);
            else {
              if (needsText.top < fieldBox.bottom || needsText.top - fieldBox.bottom > 12) failures.push(`${key}: the «write first» words stand ${needsText.top - fieldBox.bottom}px from the field`);
              if (viewport.phone && needsText.bottom > actions.top) failures.push(`${key}: the «write first» words are under the actions`);
            }
          }
          const picked = PICKED.includes(state);
          const redo = state !== "rejected" && !picked && (variant === 1 || state !== "rest");
          if (redo && state !== "armed" && !/dictate|надиктуйте/.test(reading.placeholder ?? "")) failures.push(`${key}: the field does not name dictation: ${reading.placeholder}`);
          if (redo && reading.micColor !== reading.textColor) failures.push(`${key}: the microphone is ${reading.micColor}, the text ${reading.textColor}`);
          if (variant === 1 && state !== "rejected" && !picked && reading.saveFilled) failures.push(`${key}: the unavailable save is filled beside the rejection`);
          if (variant !== 1 && (state === "armed" || state === "asks") && reading.choosable > 0) failures.push(`${key}: ${reading.choosable} variants can still be ticked in the redo mode`);
          /* A ticked variant: the save is the one filled action, it can be pressed, and the rejection is drawn apart from it. */
          if (picked) {
            if (!reading.saveFilled || reading.saveDisabled) failures.push(`${key}: the save is not the available filled action (filled ${reading.saveFilled}, disabled ${reading.saveDisabled})`);
            if (variant === 1 && (!reading.rejectBackground || reading.rejectBackground === reading.saveBackground)) failures.push(`${key}: the rejection is drawn as the save is: ${reading.rejectBackground}`);
            if (reading.chosenChips !== 1) failures.push(`${key}: ${reading.chosenChips} ticked variants are listed in the footer`);
            if (reading.chosenCut) failures.push(`${key}: the ticked variant's name is cut`);
          }
          /* Variant 3 says «none» once: the ticked chip, with only the consequence after it. */
          if (variant === 3 && (state === "armed" || state === "asks") && (!reading.noneLine || /none|жоден/i.test(reading.noneLine))) failures.push(`${key}: the words beside «None fits» repeat it: ${reading.noneLine}`);
          /* On the phone the switch and «None fits» are as tall as the actions under them. */
          if (viewport.phone && state !== "rejected") {
            const tall = reading.controls.find((entry) => entry.what === "prototypeSave")?.box[3];
            for (const entry of reading.controls) if (/^mode-|^prototypeRejectNone$/.test(entry.what) && entry.box[3] !== tall) failures.push(`${key}: ${entry.what} is ${entry.box[3]}px tall beside ${tall}px actions`);
          }
          if (state !== "rejected" && reading.actionRows !== 1) failures.push(`${key}: the actions take ${reading.actionRows} rows`);
          if (variant === 3 && state !== "rejected" && (reading.noneGap === null || reading.noneGap > 16 || !reading.noneSameRow)) failures.push(`${key}: «None fits» stands ${reading.noneGap}px from the words before it, same row ${reading.noneSameRow}`);
        }
        if (pageErrors.length) failures.push(`${key}: page errors ${pageErrors.join(" | ")}`);
        const theme = scheme === "dark" ? "темна" : "світла";
        const words = `${viewport.width} · ${lang} · ${theme} · ${STATE_WORDS[state]}`;
        const files = variant === 0
          ? VARIANTS.map((entry) => [path.join(OUT, `variant-${entry.n}-${viewport.width}-${lang}-${scheme}-${state}-original.png`), `Сьогодні, без змін — ${words}`] as const)
          : [[path.join(OUT, `${name}.png`), `Варіант ${variant} · ${VARIANTS[variant - 1]!.name} — ${words}`] as const];
        const [first] = files[0]!;
        await page.screenshot({ path: first });
        for (const [file] of files.slice(1)) fs.copyFileSync(first, file);
        for (const [file, label] of files) await band(file, label, scheme);
        console.log("frame", key);
      } finally {
        await context.close();
      }
    }
  }
} finally {
  await browser.close();
  await launched.close();
  server.stop();
}
const record = path.join(import.meta.dir, "geometry.json");
const held = ONLY && fs.existsSync(record) ? JSON.parse(fs.readFileSync(record, "utf8")) as { failures: string[]; frames: Record<string, unknown> } : { failures: [], frames: {} };
const rendered = new Set(Object.keys(geometry));
const allFailures = [...held.failures.filter((line) => !rendered.has(line.split(":")[0]!)), ...failures];
fs.writeFileSync(record, `${JSON.stringify({ fixture: "issue1695Evidence.fixture.tsx?proto=1, task t-search", failures: allFailures, frames: { ...held.frames, ...geometry } }, null, 2)}\n`);
console.log(failures.length ? `FAILURES\n${failures.join("\n")}` : "no geometry failures");
