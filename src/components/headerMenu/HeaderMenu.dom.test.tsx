import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { setLocale, translate } from "@/lib/i18n";
import type { MobileNav } from "@/components/mobile/mobileNav";

/* The header's ⋯ as the operator's mix: three icon cells, then Open on phone,
   Settings (a page with a back row, carrying memory's state) and Help and
   learning (in place), and on the phone the same between the board's rows. */

const dom = new Window({ url: "http://localhost/", width: 1440, height: 900 });
installActEnv();
const matchMediaStub = (query: string) => ({
  matches: false, media: String(query), onchange: null,
  addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
  dispatchEvent() { return false; },
});
(dom as unknown as { matchMedia: typeof matchMediaStub }).matchMedia = matchMediaStub;
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement,
  HTMLInputElement: dom.HTMLInputElement, Event: dom.Event, MouseEvent: dom.MouseEvent, PointerEvent: dom.Event,
  KeyboardEvent: dom.KeyboardEvent, sessionStorage: dom.sessionStorage, localStorage: dom.localStorage, matchMedia: matchMediaStub,
});

const originalFetch = globalThis.fetch;
const working = { enabled: true, reasons: [], keySource: "file", capUsd: 5, spentUsd: 1.214, month: "2026-10",
  counts: { decisions: 214, delivered: 61, prepared: 69, noCandidates: 48, noMatches: 97, skipped: 12, failed: 5 } };
globalThis.fetch = (async (input: unknown) => {
  const url = String(input);
  if (url.includes("/api/memory/settings")) return Response.json(working);
  if (url.includes("/api/asks-you/key")) return Response.json({ present: true, source: "file" });
  return Response.json({}, { status: 404 });
}) as typeof fetch;

const { HeaderMenuPanel, HeaderMenuSheet } = await import("./HeaderMenu");
const { RailHeaderMenu } = await import("@/components/ProjectRail");
const { OPEN_VOICE_COMPANION_SETTINGS_EVENT } = await import("@/components/voiceCompanion/VoiceCompanionSetting");

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount()); root = undefined;
  document.body.innerHTML = ""; localStorage.clear(); setLocale("en");
});
process.on("exit", () => { globalThis.fetch = originalFetch; });

async function mount(node: React.ReactNode) {
  const host = document.createElement("div"); document.body.appendChild(host); root = createRoot(host);
  await act(async () => { root!.render(node); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return host;
}
const click = async (element: Element | null) => {
  expect(element).not.toBeNull();
  await act(async () => { (element as HTMLElement).click(); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
};

for (const lang of ["en", "uk"] as const) test(`${lang}: at rest, three cells and three rows; Settings shows memory's state and opens a page with a back row`, async () => {
  setLocale(lang);
  let closed = 0;
  const host = await mount(<HeaderMenuPanel project="atlas" onClose={() => { closed += 1; }} />);
  const cells = [...host.querySelectorAll("[data-header-menu-cells] > *")];
  expect(cells.map((cell) => cell.textContent)).toEqual([translate(lang, "headerMenu.cell.activity"), translate(lang, "headerMenu.cell.team"), translate(lang, "headerMenu.cell.update")]);
  expect(cells[0]!.getAttribute("href")).toBe("/activity");
  expect(cells[1]!.getAttribute("href")).toBe("/team");
  const settings = host.querySelector("[data-rail-menu-settings]")!;
  expect(settings.textContent).toContain(translate(lang, "headerMenu.settings"));
  expect(settings.querySelector("[data-memory-state]")!.textContent).toBe(translate(lang, "memoryState.short", { state: translate(lang, "memoryState.short.working") }));
  expect(settings.textContent).toContain("10");
  /* Nothing of the settings page shows at rest, and no entry appears twice. */
  expect(host.querySelector("[data-rail-menu-agent-mapping]")).toBeNull();
  expect(host.querySelector("[data-rail-menu-memory]")).toBeNull();

  await click(settings);
  expect(host.querySelector("[data-header-menu-cells]")).toBeNull();
  const back = host.querySelector("[data-rail-menu-back]")!;
  expect(back.textContent).toBe(`${translate(lang, "headerMenu.back")}·${translate(lang, "headerMenu.settings")}`);
  expect(document.activeElement).toBe(back);
  const page = host.querySelector("[data-header-menu-page='settings']")!;
  expect(page.querySelector("[data-rail-menu-memory] [data-memory-state]")!.textContent).toBe(translate(lang, "memoryState.working", { count: 61 }));
  expect(page.querySelector("[data-rail-menu-key] [data-key-state]")!.textContent).toBe(translate(lang, "keyPage.saved"));
  expect(page.querySelector("[data-rail-menu-agent-mapping]")!.textContent).toBe(translate(lang, "headerMenu.mapping"));
  expect(page.querySelector("[data-rail-menu-external-relay]")!.textContent).toBe(translate(lang, "headerMenu.relay"));

  await click(page.querySelector("[data-rail-menu-memory]"));
  expect(host.querySelector("[data-memory-page]")).not.toBeNull();
  await click(host.querySelector("[data-rail-menu-back]"));
  expect(host.querySelector("[data-header-menu-page='settings']")).not.toBeNull();
  expect(document.activeElement).toBe(host.querySelector("[data-rail-menu-memory]"));
  await click(host.querySelector("[data-rail-menu-back]"));
  expect(host.querySelector("[data-header-menu-cells]")).not.toBeNull();
  expect(closed).toBe(0);
});

test("Install ping closes the menu and opens the ping's own dialog", async () => {
  let opened = 0;
  const open = () => { opened += 1; };
  window.addEventListener("delegatus:open-settings", open);
  let closed = 0;
  const host = await mount(<HeaderMenuPanel project="atlas" onClose={() => { closed += 1; }} />);
  await click(host.querySelector("[data-rail-menu-settings]"));
  await click(host.querySelector("[data-rail-menu-ping]"));
  window.removeEventListener("delegatus:open-settings", open);
  expect([opened, closed]).toEqual([1, 1]);
});

test("Voice Delegatus closes the menu and opens the voice companion's own settings dialog", async () => {
  let opened = 0;
  const open = () => { opened += 1; };
  window.addEventListener(OPEN_VOICE_COMPANION_SETTINGS_EVENT, open);
  let closed = 0;
  const host = await mount(<HeaderMenuPanel project="atlas" onClose={() => { closed += 1; }} />);
  await click(host.querySelector("[data-rail-menu-settings]"));
  expect(host.querySelector("[data-rail-menu-voice-companion]")!.textContent).toBe(translate("en", "voiceCompanion.settings.label"));
  await click(host.querySelector("[data-rail-menu-voice-companion]"));
  window.removeEventListener(OPEN_VOICE_COMPANION_SETTINGS_EVENT, open);
  expect([opened, closed]).toEqual([1, 1]);
});

test("Help and learning opens in place under its own row", async () => {
  const host = await mount(<HeaderMenuPanel project="atlas" onClose={() => {}} />);
  const help = host.querySelector("[data-rail-menu-help]")!;
  expect(help.getAttribute("aria-expanded")).toBe("false");
  expect(host.querySelector("[data-rail-menu-setup-guide]")).toBeNull();
  await click(help);
  expect(help.getAttribute("aria-expanded")).toBe("true");
  expect(host.querySelector("[data-header-menu-cells]")).not.toBeNull();
  expect(host.querySelector("[data-rail-menu-setup-guide]")!.textContent).toBe(translate("en", "onboarding.menu.guide"));
  expect(host.querySelector("[data-rail-menu-interface-walk]")!.textContent).toBe(translate("en", "onboarding.menu.walk"));
});

test("the overview has no project: Settings carries no memory state and its page no memory row", async () => {
  const host = await mount(<HeaderMenuPanel project={null} onClose={() => {}} />);
  const settings = host.querySelector("[data-rail-menu-settings]")!;
  expect(settings.querySelector("[data-memory-state]")).toBeNull();
  expect(settings.textContent).toContain("9");
  await click(settings);
  expect(host.querySelector("[data-rail-menu-memory]")).toBeNull();
  expect(host.querySelector("[data-rail-menu-key]")).not.toBeNull();
});

test("phone: create cells, the board's rows, the header's cells and rows, and the project's rules as a page; Settings is a page of the sheet", async () => {
  dom.innerWidth = 390;
  const closes: string[] = [];
  const nav = { closeSheet: () => closes.push("close"), leave: (url: string) => closes.push(`leave ${url}`) } as unknown as MobileNav;
  const host = await mount(
    <HeaderMenuSheet
      title="atlas"
      project="atlas"
      nav={nav}
      board={[{ kind: "row", key: "tasks", label: "Tasks", onSelect: () => {} }]}
      create={[{ kind: "row", key: "new-task", label: "New task", onSelect: () => {} }]}
      rules={[{ kind: "row", key: "archive", label: "Archive", onSelect: () => {} }]}
      onClose={() => closes.push("close")}
    />,
  );
  const sheet = document.body;
  const rows = [...sheet.querySelectorAll("[data-mobile2-menu-row]")].map((row) => row.getAttribute("data-mobile2-menu-row"));
  expect(rows).toEqual(["new-task", "tasks", "activity", "team", "self-update", "settings", "help", "rules"]);
  expect(sheet.querySelector("[data-mobile2-menu-row='settings'] [data-memory-state]")).not.toBeNull();
  await click(sheet.querySelector("[data-mobile2-menu-row='help']"));
  expect([...sheet.querySelectorAll("[data-mobile2-menu-row]")].map((row) => row.getAttribute("data-mobile2-menu-row"))).toEqual(["back", "setup-guide", "interface-walk"]);
  await click(sheet.querySelector("[data-mobile2-menu-row='back']"));
  await click(sheet.querySelector("[data-mobile2-menu-row='settings']"));
  const page = [...sheet.querySelectorAll("[data-mobile2-menu-row]")].map((row) => row.getAttribute("data-mobile2-menu-row"));
  expect(page).toEqual(["back", "memory", "key", "agent-mapping", "dictation", "linked-settings", "external-relay", "ping"]);
  expect(sheet.textContent).toContain(translate("en", "mobile2.menu.sound"));
  await click(sheet.querySelector("[data-mobile2-menu-row='memory']"));
  expect(sheet.querySelector("[data-memory-page]")).not.toBeNull();
  await click(sheet.querySelector("[data-mobile2-menu-row='back']"));
  await click(sheet.querySelector("[data-mobile2-menu-row='back']"));
  expect(sheet.querySelector("[data-header-menu-cells]")).not.toBeNull();
  await click(sheet.querySelector("[data-mobile2-menu-row='rules']"));
  expect([...sheet.querySelectorAll("[data-mobile2-menu-row]")].map((row) => row.getAttribute("data-mobile2-menu-row"))).toEqual(["back", "archive"]);
  expect(host).not.toBeNull();
});

test("desktop: Escape closes the menu from every page and hands focus back to ⋯", async () => {
  const host = await mount(<RailHeaderMenu project="atlas" />);
  const trigger = host.querySelector<HTMLButtonElement>("[data-rail-menu]")!;
  const escape = async () => { await act(async () => { window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" })); }); };
  const pages: [string, string[]][] = [
    ["rest", []],
    ["help", ["[data-rail-menu-help]"]],
    ["settings", ["[data-rail-menu-settings]"]],
    ["memory", ["[data-rail-menu-settings]", "[data-rail-menu-memory]"]],
    ["memory, then back", ["[data-rail-menu-settings]", "[data-rail-menu-memory]", "[data-rail-menu-back]"]],
    ["key", ["[data-rail-menu-settings]", "[data-rail-menu-key]"]],
  ];
  for (const [name, path] of pages) {
    await click(trigger);
    for (const step of path) await click(host.querySelector(step));
    if (path.length) expect(document.activeElement === document.body).toBe(false);
    await escape();
    expect([name, host.querySelector("[data-rail-menu-panel]"), trigger.getAttribute("aria-expanded")]).toEqual([name, null, "false"]);
    expect([name, document.activeElement === trigger]).toEqual([name, true]);
  }
});

test("phone: a page takes focus on its back row, and back returns it to the row that opened the page", async () => {
  dom.innerWidth = 390;
  const nav = { closeSheet: () => {}, leave: () => {} } as unknown as MobileNav;
  await mount(
    <HeaderMenuSheet title="atlas" project="atlas" nav={nav} board={[]} rules={[{ kind: "row", key: "archive", label: "Archive", onSelect: () => {} }]} onClose={() => {}} />,
  );
  const row = (key: string) => document.querySelector<HTMLElement>(`[data-mobile2-sheet='menu'] [data-mobile2-menu-row='${key}']`);
  const press = async (key: string) => { row(key)!.focus(); await click(row(key)); };
  for (const path of [["settings", "memory"], ["settings", "key"], ["help"], ["rules"]]) {
    for (const key of path) {
      await press(key);
      expect([key, document.activeElement?.getAttribute("data-mobile2-menu-row")]).toEqual([key, "back"]);
    }
    for (const key of [...path].reverse()) {
      await press("back");
      expect([key, document.activeElement === row(key)]).toEqual([key, true]);
    }
  }
});
