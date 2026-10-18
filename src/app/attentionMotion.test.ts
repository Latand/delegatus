import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";

/*
 * The attention cues must not paint on the main thread beside a composer. The
 * ring's motion is a compositor property; the cues that grow a shadow pause
 * while a composer field has the focus. These read the stylesheet itself.
 */
const css = fs.readFileSync(path.resolve(import.meta.dir, "globals.css"), "utf8");

function rule(selector: string): string {
  const start = css.indexOf(`${selector} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("\n}", start));
}
function keyframes(name: string): string {
  const start = css.indexOf(`@keyframes ${name} {`);
  expect(start).toBeGreaterThanOrEqual(0);
  return css.slice(start, css.indexOf("\n}\n", start));
}

test("the pane ring turns by transform only, on the same 3.4s lap as before", () => {
  const frames = keyframes("pane-orbit");
  expect(frames).toContain("transform: rotate(360deg)");
  expect(frames).not.toContain("--pane-angle");
  expect(css).not.toContain("@property --pane-angle");
  expect(rule(".pane-attention-comets")).toContain("animation: pane-orbit 3.4s linear infinite");
});

test("the ring keeps its colours: two comets of the state's glow on the same stops", () => {
  const comets = rule(".pane-attention-comets");
  expect(comets).toContain("conic-gradient(");
  for (const stop of ["transparent 0deg 30deg", "var(--pane-glow) 100deg", "transparent 170deg 210deg", "var(--pane-glow) 280deg", "transparent 350deg 360deg"]) expect(comets).toContain(stop);
});

test("the frame is a static mask and reduced motion stills the comets", () => {
  const ring = rule(".pane-attention-ring");
  expect(ring).toContain("inset: -2px");
  expect(ring).toContain("mask-composite: exclude");
  expect(ring).not.toContain("animation");
  expect(css).toMatch(/prefers-reduced-motion: reduce\) \{\s*\.pane-attention-comets \{\s*animation: none;/);
});

test("the ring and the shadow-growing cues hold their frame while a composer field has the focus", () => {
  const start = css.indexOf(":root[data-composer-focused] .pane-attention-comets");
  expect(start).toBeGreaterThanOrEqual(0);
  const block = css.slice(start, css.indexOf("}", start));
  for (const selector of [".pane-attention-comets", ".card-status-attention", ".deck-tab-live", "[data-attention-pulse][data-attention-pulse]"]) expect(block).toContain(`:root[data-composer-focused] ${selector}`);
  /* The standing liveness motion of a board holds too: a running agent's glyph (halo and SVG groups) and the pulsing dots. */
  for (const selector of ['.mglyph[data-live="1"]::before', '.mglyph[data-live="1"] *', ".animate-pulse"]) expect(block).toContain(`:root[data-composer-focused] ${selector}`);
  expect(block).toContain("animation-play-state: paused");
});
