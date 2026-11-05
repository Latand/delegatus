import { afterEach, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { installActEnv } from "@/test-helpers/actEnv";

/* The status dot and its popover (the operator's rule of 2026-10-12: a small dot and a short popover, never a text
   pill), a literal value that stays whole, and a row's two controls standing beside each other. */

const dom = new Window({ url: "http://localhost/", width: 1440, height: 900 });
installActEnv();
const matchMedia = (query: string) => ({ matches: false, media: query, onchange: null, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; } });
(dom as unknown as { matchMedia: typeof matchMedia }).matchMedia = matchMedia;
Object.assign(globalThis, { window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, HTMLElement: dom.HTMLElement, Event: dom.Event, MouseEvent: dom.MouseEvent, KeyboardEvent: dom.KeyboardEvent, PointerEvent: dom.Event, localStorage: dom.localStorage, matchMedia, innerWidth: 1440, innerHeight: 900 });
const { ConfirmAction, LinkRow, Literal, markLiterals, Prose, SectionHead, SettingsDensity } = await import("./settingsRows");
const { LAYER } = await import("@/components/layers");

let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); root = undefined; document.body.innerHTML = ""; });
async function mount(node: React.ReactNode): Promise<HTMLElement> {
  const host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => { root!.render(node); });
  return host;
}

const popover = () => document.querySelector<HTMLElement>("[data-settings-dot-popover]");

test("a tap on the dot toggles a short popover in a portal over the window, and opens nothing of the row", async () => {
  let opened = 0;
  const host = await mount(<LinkRow label="Release notes" value="Not delivered" hint="group" dot={{ tone: "warn", note: "Delegatus Atlas: removed from the chat" }} onOpen={() => { opened += 1; }} />);
  const dot = host.querySelector<HTMLButtonElement>("[data-settings-dot='warn']")!;
  expect(popover()).toBeNull();
  await act(async () => { dot.click(); });
  expect(popover()?.textContent).toBe("Delegatus Atlas: removed from the chat");
  expect(popover()!.parentElement).toBe(document.body);
  expect(popover()!.className).toContain(`z-[${LAYER.popover}]`);
  expect(popover()!.getAttribute("role")).toBe("tooltip");
  expect(dot.getAttribute("aria-expanded")).toBe("true");
  expect(dot.getAttribute("aria-label")).toBe("Release notes: Delegatus Atlas: removed from the chat");
  expect(opened).toBe(0);
  await act(async () => { dot.click(); });
  expect(popover()).toBeNull();
  expect(opened).toBe(0);
});

test("Escape closes the popover alone: a listener behind it, as the window's own, hears nothing", async () => {
  const host = await mount(<LinkRow label="Bot" dot={{ tone: "ok", note: "Receiving messages." }} onOpen={() => {}} />);
  let closedWindow = 0;
  const behind = (event: Event) => { if ((event as KeyboardEvent).key === "Escape") closedWindow += 1; };
  window.addEventListener("keydown", behind);
  try {
    await act(async () => { host.querySelector<HTMLButtonElement>("[data-settings-dot]")!.click(); });
    expect(popover()).not.toBeNull();
    const press = () => act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await press();
    expect(popover()).toBeNull();
    expect(closedWindow).toBe(0);
    await press();
    expect(closedWindow).toBe(1);
  } finally { window.removeEventListener("keydown", behind); }
});

test("a row with a dot and a chevron keeps its two buttons as siblings, with no control inside a control", async () => {
  const host = await mount(<LinkRow label="Telegram bot" value="Saved" dot={{ tone: "ok", note: "Saved." }} onOpen={() => {}} />);
  expect(host.querySelector("button button")).toBeNull();
  const buttons = host.querySelectorAll("button");
  expect(buttons).toHaveLength(2);
  expect(buttons[0]!.parentElement).toBe(buttons[1]!.parentElement);
  expect(host.querySelector("[data-settings-chevron]")).not.toBeNull();
});

test("a row with no action keeps the chevron's slot and is no button", async () => {
  const host = await mount(<LinkRow label="Add a tool" hint="Ask the voice." />);
  expect(host.querySelector("button")).toBeNull();
  expect(host.querySelector("[data-settings-chevron]")).toBeNull();
});

test("a literal keeps its text whole for a copy, breaks only after / or :, and never at NAME=value's =", async () => {
  const hash = "a".repeat(64);
  const host = await mount(<><Literal text="/srv/atlas/reports/2026" /><Literal text={`stdio:spotify:sha256:${hash}`} /><Literal text="SPOTIFY_REDIRECT_URI=http://127.0.0.1:8888/callback" /></>);
  const [path, recipient, variable] = [...host.querySelectorAll<HTMLElement>("[data-settings-literal]")];
  expect(path!.textContent).toBe("/srv/atlas/reports/2026");
  expect(path!.title).toBe(path!.textContent!);
  expect(path!.querySelectorAll("wbr")).toHaveLength(4);
  /* The hash is middle-elided by layout alone: the DOM and the title carry all of it. */
  expect(recipient!.textContent).toBe(`stdio:spotify:sha256:${hash}`);
  expect(recipient!.title).toBe(recipient!.textContent!);
  expect(recipient!.querySelector(".truncate")?.textContent).toBe(hash.slice(0, -8));
  /* No break opportunity before the value starts, and none inside "http://". */
  expect(variable!.firstElementChild!.textContent).toBe("SPOTIFY_REDIRECT_URI=http://");
  expect(variable!.firstElementChild!.className).toContain("whitespace-nowrap");
});

test("prose marks only what backticks mark, and punctuation stays with its literal", async () => {
  const host = await mount(<Prose text="use `/revoke` in `@BotFather`." />);
  const literals = [...host.querySelectorAll("[data-settings-literal]")].map((node) => node.textContent);
  expect(literals).toEqual(["/revoke", "@BotFather."]);
  expect(host.textContent).toBe("use /revoke in @BotFather.");
});

test("the notice's variables and domain are marked as literals, with the sentence's punctuation left outside", () => {
  expect(markLiterals("sends to delegatus.org once a day. Turn off with DELEGATUS_TELEMETRY=0 or DO_NOT_TRACK=1.")).toBe("sends to `delegatus.org` once a day. Turn off with `DELEGATUS_TELEMETRY=0` or `DO_NOT_TRACK=1`.");
});

/* A pointer's move: React reads enter and leave from the over and out events and their related targets. */
const pointer = (type: "pointerover" | "pointerout", target: Element, related: Element | null) => act(async () => {
  const event = new dom.Event(type, { bubbles: true }) as unknown as Event;
  Object.defineProperties(event, { pointerType: { value: "mouse" }, relatedTarget: { value: related } });
  target.dispatchEvent(event);
});
const wait = (ms: number) => act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); });

test("the pointer may move from the dot onto its popover and read it there; leaving both closes it, and Escape still closes it alone", async () => {
  const host = await mount(<LinkRow label="Release notes" dot={{ tone: "warn", note: "Delegatus Atlas: removed from the chat" }} onOpen={() => {}} />);
  const dot = host.querySelector<HTMLButtonElement>("[data-settings-dot]")!;
  await pointer("pointerover", dot, null);
  expect(popover()).not.toBeNull();
  await pointer("pointerout", dot, popover());
  await pointer("pointerover", popover()!, dot);
  await wait(300);
  expect(popover()?.textContent).toBe("Delegatus Atlas: removed from the chat");
  await pointer("pointerout", popover()!, document.body);
  await wait(300);
  expect(popover()).toBeNull();
  await pointer("pointerover", dot, null);
  await act(async () => { document.body.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(popover()).toBeNull();
});

test("arming a removal moves the keyboard into the confirm with its prompt announced, and Cancel returns it to Remove", async () => {
  let removed = 0;
  const host = await mount(<ConfirmAction label="Remove bot" prompt="Remove the bot and every chat it stored?" onConfirm={() => { removed += 1; }} />);
  const remove = () => [...host.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent === "Remove bot");
  remove()!.focus();
  await act(async () => { remove()!.click(); });
  const confirm = host.querySelector<HTMLElement>("[data-settings-confirm]")!;
  expect(confirm.contains(document.activeElement)).toBe(true);
  expect(document.activeElement?.textContent).toBe("Cancel");
  const alert = confirm.querySelector("[role='alert']")!;
  expect(alert.textContent).toBe("Remove the bot and every chat it stored?");
  expect(confirm.getAttribute("role")).toBe("group");
  expect(confirm.getAttribute("aria-labelledby")).toBe(alert.id);
  await act(async () => { (document.activeElement as HTMLButtonElement).click(); });
  expect(host.querySelector("[data-settings-confirm]")).toBeNull();
  expect(document.activeElement).toBe(remove()!);
  expect(removed).toBe(0);
});

for (const density of ["dialog", "sheet"] as const) test(`a section title is a heading under the page's own (${density})`, async () => {
  const host = await mount(<SettingsDensity.Provider value={density}><SectionHead title="Chats" count={3} /></SettingsDensity.Provider>);
  const head = host.querySelector<HTMLElement>("[data-settings-section]")!;
  const level = head.tagName === "H4" ? 4 : head.getAttribute("role") === "heading" ? Number(head.getAttribute("aria-level")) : 0;
  expect(level).toBe(density === "dialog" ? 4 : 3);
  expect(head.textContent).toBe("Chats3");
});
