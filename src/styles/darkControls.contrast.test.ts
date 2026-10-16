import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

/*
 * The dark-theme conversation controls (darkControls.css) are filled and
 * outlined with existing tokens and with color-mix blends of them. This pins
 * the ratios the approved «Суцільний акцент» notes give, from the token values
 * in tokens.css, so a palette change that drops one under its floor fails here.
 */

const TOKENS = fs.readFileSync(path.join(import.meta.dir, "tokens.css"), "utf8");
const RULES = fs.readFileSync(path.join(import.meta.dir, "darkControls.css"), "utf8");

/** The token's value in tokens.css's dark block (`prefers-color-scheme: dark`), whatever the light value or the declaration order. */
const DARK_TOKENS = TOKENS.slice(TOKENS.indexOf("@media (prefers-color-scheme: dark)"), TOKENS.indexOf('[data-theme="dark"] {'));
function dark(name: string): string {
  const match = DARK_TOKENS.match(new RegExp(`--${name}:\\s*(#[0-9a-f]{6})`, "i"));
  expect(match).not.toBeNull();
  return match![1].toLowerCase();
}

const rgb = (hex: string): number[] => [1, 3, 5].map((offset) => parseInt(hex.slice(offset, offset + 2), 16));
const hex = (channels: number[]): string => `#${channels.map((value) => Math.round(value).toString(16).padStart(2, "0")).join("")}`;
/** `color-mix(in srgb, first share%, second)` */
function mix(first: string, share: number, second: string): string {
  const [a, b] = [rgb(first), rgb(second)];
  return hex(a.map((value, index) => value * share + b[index] * (1 - share)));
}
function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((value) => value / 255).map((value) => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(foreground: string, background: string): number {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}

const canvas = dark("surface-canvas");
const card = dark("surface-card");
const raised = dark("surface-raised");
const strong = dark("border-strong");
const primary = dark("color-primary");
const muted = dark("color-muted");
const accent = dark("color-accent");
const info = dark("color-info");
const secondary = dark("color-secondary");
const accentSoft = dark("color-accent-soft");
const hover = mix(accent, 0.88, primary);
const pressed = mix(accent, 0.88, canvas);
const infoHover = mix(info, 0.88, primary);
const infoPressed = mix(info, 0.88, canvas);
const pillPressed = mix(accent, 0.25, card);

test("Send and «Говорити» carry a canvas glyph on the accent fill at every state", () => {
  expect(contrast(canvas, accent)).toBeGreaterThanOrEqual(6.3);
  expect(contrast(canvas, hover)).toBeGreaterThanOrEqual(7.1);
  expect(contrast(canvas, pressed)).toBeGreaterThanOrEqual(5.1);
});

test("«↓ N нових» keeps text contrast at rest, hover and pressed", () => {
  expect(contrast(accent, card)).toBeGreaterThanOrEqual(5.8);
  expect(contrast(accent, accentSoft)).toBeGreaterThanOrEqual(5);
  expect(contrast(primary, pillPressed)).toBeGreaterThanOrEqual(9.3);
});

test("composer icons stay legible at rest and on the raised hover", () => {
  expect(contrast(muted, card)).toBeGreaterThanOrEqual(5.1);
  expect(contrast(accent, raised)).toBeGreaterThanOrEqual(5.3);
  /* Pressed: a glyph, so the 3:1 non-text floor. */
  expect(contrast(accent, strong)).toBeGreaterThanOrEqual(3);
});

test("context-mode Send keeps its info fill with a canvas glyph at every state", () => {
  expect(contrast(canvas, info)).toBeGreaterThanOrEqual(10);
  expect(contrast(canvas, infoHover)).toBeGreaterThanOrEqual(10);
  expect(contrast(canvas, infoPressed)).toBeGreaterThanOrEqual(7.9);
});

test("the hint bubble and the offline chip keep their text contrast", () => {
  expect(contrast(primary, raised)).toBeGreaterThanOrEqual(12.8);
  expect(contrast(secondary, canvas)).toBeGreaterThanOrEqual(7.4);
});

test("a state colour is left alone: muted call, connecting mic, context Send", () => {
  for (const scope of RULES.split(/(?=^\/\* `data-theme="dark"` pins)/m)) {
    expect(scope).toContain('.vc-btn:not([data-on]):hover { color: var(--color-accent); }');
    expect(scope).not.toMatch(/\.vc-btn:hover\s*\{[^}]*color:/);
    expect(scope).toContain('.composer-ghost:not([aria-pressed="true"]):not([data-mic-phase="starting"]) { color: var(--color-muted); }');
    expect(scope).toContain('button[data-composer-send][data-composer-send-tone="info"] { --dc-send: var(--color-info); }');
  }
  expect(RULES.split(/(?=^\/\* `data-theme="dark"` pins)/m).length).toBe(2);
});

test("a Send or Stop that cannot act keeps its dim on hover and press, in both scopes", () => {
  const scopes = RULES.split(/(?=^\/\* `data-theme="dark"` pins)/m);
  expect(scopes.length).toBe(2);
  for (const scope of scopes) {
    const states = scope.split("\n").filter((line) => /composer-send/.test(line) && /:(?:hover|active):not\(:disabled\)/.test(line));
    /* Six for Send and its phone visual, one for the phone Stop's press. */
    expect(states.length).toBe(7);
    for (const line of states) expect(line).toContain(':not([aria-disabled="true"])');
  }
});

/* The rest of the dark controls (the audit of 2026-10-16). */
const sunken = dark("surface-sunken");
const well = dark("surface-well");
const success = dark("color-success");
const warning = dark("color-warning");
const danger = dark("color-danger");
const brand = dark("color-brand");
const white = "#ffffff";
/** The two scopes' audit blocks, each with its scope prefix and indent stripped. */
function auditBlocks(): string[] {
  return RULES.split(/(?=^\/\* `data-theme="dark"` pins)/m).map((scope) => {
    const block = scope.slice(scope.indexOf("Every other control"));
    return block.replace(/:root(?::not\(\[data-theme="light"\]\)|\[data-theme="dark"\])/g, ":root").replace(/^ +/gm, "").replace(/\n}\s*$/, "").trim();
  });
}

test("a filled primary action takes the accent with a canvas label instead of the cream brand slab", () => {
  expect(contrast(brand, card)).toBeGreaterThan(14);
  for (const fill of [accent, hover, pressed]) expect(contrast(canvas, fill)).toBeGreaterThanOrEqual(5.1);
  for (const block of auditBlocks()) {
    expect(block).toContain(":root .bg-brand { background-color: var(--color-accent); }");
    expect(block).toContain(":root .text-on-brand { color: var(--color-canvas); }");
  }
});

test("white on the dark accent, success, warning and info fills is replaced by the canvas; red danger keeps its white", () => {
  for (const fill of [accent, success, warning, info]) {
    expect(contrast(white, fill)).toBeLessThan(3);
    expect(contrast(canvas, fill)).toBeGreaterThanOrEqual(6.3);
  }
  for (const block of auditBlocks()) {
    expect(block).toContain(":root :is(.bg-accent, .bg-success, .bg-warning, .bg-info).text-white,");
    expect(block).not.toMatch(/bg-danger|color-danger/);
  }
  expect(danger).toBe("#f07171");
});

test("the phone Stop, the switch knob and the focus ring hold their floors", () => {
  expect(contrast(primary, raised)).toBeGreaterThanOrEqual(12.8);
  expect(contrast(primary, strong)).toBeGreaterThanOrEqual(8.4);
  /* Non-text: the 3:1 floor. */
  expect(contrast(card, accent)).toBeGreaterThanOrEqual(5.8);
  expect(contrast(muted, sunken)).toBeGreaterThanOrEqual(5.4);
  for (const ground of [canvas, card, raised, sunken, well]) expect(contrast(accent, ground)).toBeGreaterThanOrEqual(5.3);
  /* The browser's own ring takes the accent without outranking any authored outline. */
  for (const block of auditBlocks()) expect(block).toContain(":where(:root) :where(:focus-visible) { outline-color: var(--color-accent); }");
});

test("a hover wash lifts to the raised surface and keeps every label over 4.5:1", () => {
  for (const label of [muted, secondary, primary]) expect(contrast(label, raised)).toBeGreaterThanOrEqual(4.6);
  /* The well it replaces sat below the card it was drawn on. */
  expect(luminance(well)).toBeLessThan(luminance(card));
  expect(luminance(raised)).toBeGreaterThan(luminance(card));
  /* A lighter step (the strong line as a fill) would take muted labels under the floor, which is why a press draws a line. */
  expect(contrast(muted, strong)).toBeLessThan(4.5);
  for (const block of auditBlocks()) expect(block).toContain(":root { --dc-hover: var(--color-raised); }");
});

test("the audit rules are the same in both dark scopes and never reach the light theme", () => {
  const [system, pinned] = auditBlocks();
  expect(system).toBe(pinned);
  expect(system.length).toBeGreaterThan(2000);
  /* `--dc-hover` is declared only by the two dark scopes; the light theme reads each rule's fallback. */
  expect(RULES.match(/--dc-hover:/g)?.length).toBe(2);
  expect(TOKENS).not.toContain("--dc-hover");
  for (const sheet of ["../components/kanban/kanbanBoard.css", "../components/pipelines/pipelineBlock.css"]) {
    const uses = fs.readFileSync(path.join(import.meta.dir, sheet), "utf8").match(/var\(--dc-hover[^;]*;/g) ?? [];
    expect(uses.length).toBeGreaterThan(0);
    for (const use of uses) expect(use).toMatch(/^var\(--dc-hover, var\(--surface-(well|sunken)/);
  }
});

test("the rules read the tokens the numbers above come from", () => {
  expect(RULES).toContain("color-mix(in srgb, var(--color-accent) 88%, var(--color-primary))");
  expect(RULES).toContain("color-mix(in srgb, var(--color-accent) 88%, var(--color-canvas))");
  expect(RULES).toContain("color-mix(in srgb, var(--color-accent) 25%, var(--color-card))");
  expect(RULES).not.toMatch(/data-proto/);
});
