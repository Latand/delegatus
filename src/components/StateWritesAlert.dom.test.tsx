import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { installActEnv } from "@/test-helpers/actEnv";
const dom = new Window();
installActEnv();
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, localStorage: dom.localStorage });
const { StateWritesAlert } = await import("./StateWritesAlert");
const { setLocale } = await import("@/lib/i18n");
let root: Root | null = null;
afterEach(async () => { await act(async () => root?.unmount()); root = null; document.body.replaceChildren(); });
async function render(state?: "ok" | "disk-full") {
  const host = document.createElement("div"); document.body.appendChild(host);
  await act(async () => { root = createRoot(host); root.render(<StateWritesAlert storage={state ? { incidents: [], writes: { state, freeBytes: 32 * 1024 * 1024, since: "2026-10-01T12:00:00Z" } } : undefined} />); });
  return host;
}
test.each(["en", "uk"] as const)("%s alert shows free space and recovery instructions", async (locale) => {
  setLocale(locale);
  const host = await render("disk-full");
  expect(host.querySelector('[role="alert"]')).not.toBeNull();
  expect(host.textContent).toContain("32");
  expect(host.textContent).toContain(locale === "en" ? "recovers by itself" : "відновиться сама");
});
test.each(["ok", undefined] as const)("no alert for %s", async (state) => {
  expect((await render(state)).querySelector('[role="alert"]')).toBeNull();
});
