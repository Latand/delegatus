import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import { DraftLaunchStatus } from "./DraftLaunchStatus";

test("booting announces politely and spins reduced-motion safe", () => {
  const html = renderToStaticMarkup(<DraftLaunchStatus phase="booting" />);
  expect(html).toContain('role="status"');
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain("animate-spin");
  expect(html).toContain("motion-reduce:animate-none");
});

test("the slow phases add a second line under the status", () => {
  const lines = (html: string) => html.match(/<div/g)?.length ?? 0;
  expect(lines(renderToStaticMarkup(<DraftLaunchStatus phase="booting-slow" />)))
    .toBeGreaterThan(lines(renderToStaticMarkup(<DraftLaunchStatus phase="booting" />)));
  expect(lines(renderToStaticMarkup(<DraftLaunchStatus phase="confirming-slow" />)))
    .toBeGreaterThan(lines(renderToStaticMarkup(<DraftLaunchStatus phase="confirming" />)));
});

test("confirming keeps the card polite while the launch converges", () => {
  const html = renderToStaticMarkup(<DraftLaunchStatus phase="confirming" />);
  expect(html).toContain('aria-live="polite"');
  expect(html).toContain("animate-spin");
});

test("attention is assertive, focusable, and static", () => {
  const html = renderToStaticMarkup(<DraftLaunchStatus phase="attention" />);
  expect(html).toContain('aria-live="assertive"');
  expect(html).toContain("tabindex=\"-1\"");
  /* The terminal state uses a static glyph with no working animation. */
  expect(html).not.toContain("animate-spin");
});

test("no phase names a terminal window to check", () => {
  for (const phase of ["booting", "booting-slow", "confirming", "confirming-slow", "attention"] as const) {
    expect(renderToStaticMarkup(<DraftLaunchStatus phase={phase} />)).not.toMatch(/tmux|\{target\}/i);
  }
});

test("a verified launch failure replaces the generic attention copy with the teaching error", () => {
  const generic = renderToStaticMarkup(<DraftLaunchStatus phase="attention" />);
  const html = renderToStaticMarkup(<DraftLaunchStatus
    phase="attention"
    error="Claude account botfatherdev-2 needs re-login. Open Accounts, sign in, and retry."
  />);
  expect(html).toContain("Claude account botfatherdev-2 needs re-login");
  expect(html).not.toBe(generic);
});
