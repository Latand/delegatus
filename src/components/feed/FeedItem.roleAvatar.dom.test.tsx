import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import type { ReactElement } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";

import { MOBILE_LAYOUT_QUERY, mobileLayoutViewport } from "@/lib/attention/eligibility";
import { setLocale, translate } from "@/lib/i18n";

import { ConversationRoleScope, roleAvatarUri } from "@/components/brand/RoleAvatar";
import type { FrameRole } from "@/lib/roleFrames";
import { ROLE_IDS } from "@/lib/roles/types";

import { cardAvatarRole, FeedItem } from "./FeedItem";
import type { Item } from "./parse";

/*
 * Role avatars in the feed (docs/design/role-avatars.md): an answer in a
 * conversation whose role the surface resolved draws Delegatus in that role's
 * costume, and the engine keeps its glyph and name beside the time, apart from
 * the role. A message another agent sent draws the sender's costume with the
 * role's name alone, and the phone's card clock drops its seconds.
 *
 * Phone-ness is the viewport query `useIsMobile` consults.
 */

const VIEWPORTS = {
  narrowPhone: { width: 390, height: 844 },
  desktop: { width: 1280, height: 800 },
} as const;
type ViewportName = keyof typeof VIEWPORTS;
let viewport: { width: number; height: number } = VIEWPORTS.desktop;

const setViewport = (name: ViewportName) => { viewport = VIEWPORTS[name]; };

const normalize = (query: string) => String(query).replace(/\s+/g, "");
const matchMediaStub = (query: string) => ({
  matches: normalize(query) === normalize(MOBILE_LAYOUT_QUERY) ? mobileLayoutViewport(viewport) : false,
  media: String(query),
  onchange: null,
  addEventListener() {},
  removeEventListener() {},
  addListener() {},
  removeListener() {},
  dispatchEvent() { return false; },
});

const dom = new Window({ url: "http://localhost/" });
(dom as unknown as { matchMedia: unknown }).matchMedia = matchMediaStub;
Object.assign(globalThis, {
  window: dom,
  document: dom.document,
  navigator: dom.navigator,
  Node: dom.Node,
  HTMLElement: dom.HTMLElement,
  HTMLButtonElement: dom.HTMLButtonElement,
  HTMLDetailsElement: dom.HTMLDetailsElement,
  Event: dom.Event,
  MouseEvent: dom.MouseEvent,
  matchMedia: matchMediaStub,
});

let root: Root | null = null;
afterEach(() => {
  if (root) flushSync(() => root!.unmount());
  root = null;
  setViewport("desktop");
  dom.document.body.replaceChildren();
  setLocale("en");
});

function mount(node: ReactElement): Element {
  const el = dom.document.createElement("div");
  dom.document.body.append(el);
  root = createRoot(el as unknown as HTMLElement);
  flushSync(() => root!.render(node));
  return el as unknown as Element;
}

const TS = "2026-09-02T13:43:07Z";
const prose = (): Item => ({ kind: "prose", ts: TS, engine: "claude", text: "The projection lives in one module." }) as Item;
const card = (peer: string): Item => ({ kind: "tmsg", ts: TS, dir: "in", peer, summary: "", text: "APPROVE", internal: true }) as Item;
const clock = (options: Intl.DateTimeFormatOptions) => new Date(TS).toLocaleTimeString("en-US", { hour12: false, ...options });
const text = (el: Element | null) => (el?.textContent ?? "").replace(/\s+/g, " ").trim();

describe("the sender's costume on an internal card", () => {
  test("a registry role, an older spawn word or the agent with no role picks a costume; Delegatus's own relays do not", () => {
    const t = (key: Parameters<typeof translate>[1]) => translate("uk", key);
    for (const role of ROLE_IDS) expect(cardAvatarRole(role, t)).toBe(role);
    expect(cardAvatarRole("implementer", t)).toBe("builder");
    expect(cardAvatarRole("agent", t)).toBe("neutral");
    expect(cardAvatarRole(translate("uk", "render.agentPeer"), t)).toBe("neutral");
    for (const peer of ["controller", "pipeline", "seat-tick", "gateway", "api-client", "voice-delegatus"]) expect(cardAvatarRole(peer, t)).toBeNull();
  });

  test("desktop: the card draws the reviewer's costume and the role's name alone, the clock keeps its seconds", () => {
    const host = mount(<FeedItem item={card("reviewer")} />);
    const avatar = host.querySelector('[data-role-avatar="reviewer"]');
    expect(avatar?.getAttribute("width")).toBe("26");
    expect(avatar?.getAttribute("alt")).toBe("");
    expect(host.querySelector("[data-brand-mark]")).toBeNull();
    expect(text(host.querySelector("[data-agent-author]"))).toBe("Reviewer");
    expect(host.querySelector("[data-agent-author]")?.getAttribute("class")).toContain("truncate");
    expect(text(host.querySelector("[data-card-clock]"))).toBe(clock({ hour: "numeric", minute: "numeric", second: "numeric" }));
  });

  test("phone: the card clock drops its seconds, and Ukrainian names the role alone", () => {
    setViewport("narrowPhone");
    setLocale("uk");
    const host = mount(<FeedItem item={card("issue-reporter")} />);
    expect(host.querySelector('[data-role-avatar="issue-reporter"]')).toBeTruthy();
    expect(text(host.querySelector("[data-agent-author]"))).toBe(translate("uk", "roleCopy.issue-reporter.name"));
    expect(text(host.querySelector("[data-card-clock]"))).toBe(new Date(TS).toLocaleTimeString("uk-UA", { hour12: false, hour: "2-digit", minute: "2-digit" }));
  });

  test("a card from an agent with no role wears the tuxedo and reads «Agent»; a relay by Delegatus itself keeps the mark", () => {
    const host = mount(<><FeedItem item={card("agent")} /><FeedItem item={card("controller")} /></>);
    const [agent, controller] = [...host.querySelectorAll("[data-agent-author]")];
    expect(host.querySelectorAll('[data-role-avatar="neutral"]').length).toBe(1);
    expect(text(agent!)).toBe("Agent");
    expect(text(controller!)).toBe("Agent · Delegatus");
    expect(host.querySelectorAll("[data-brand-mark]").length).toBe(1);
  });
});

describe("the conversation's costume on its answers", () => {
  test("curator and unknown roles render the neutral drawing and retain the engine", () => {
    const roles = ["curator", "future-role", "toString", "constructor", "__proto__"];
    const host = mount(<>{roles.map((role) => (
      <ConversationRoleScope key={role} value={role as FrameRole}><FeedItem item={prose()} /></ConversationRoleScope>
    ))}</>);
    const avatars = [...host.querySelectorAll("[data-role-avatar]")];
    expect(avatars).toHaveLength(roles.length);
    for (const avatar of avatars) expect(avatar.getAttribute("src")).toBe(roleAvatarUri("neutral"));
    for (const role of roles) expect(roleAvatarUri(role)).toBe(roleAvatarUri("neutral"));
    expect(host.querySelectorAll('[data-engine-mark="claude"]')).toHaveLength(roles.length);
  });

  test("desktop: without a resolved role the answer keeps today's engine circle", () => {
    const host = mount(<FeedItem item={prose()} />);
    expect(host.querySelector("[data-role-avatar]")).toBeNull();
    expect(host.querySelector(".bg-claude")).toBeTruthy();
    expect(host.querySelector("[data-message-engine]")).toBeNull();
  });

  test("desktop: a builder's answer draws the hard hat at 26 px and keeps the engine's glyph and name beside the time", () => {
    const host = mount(<ConversationRoleScope value="builder"><FeedItem item={prose()} /></ConversationRoleScope>);
    const avatar = host.querySelector('[data-role-avatar="builder"]');
    expect(avatar?.getAttribute("width")).toBe("26");
    expect(avatar?.getAttribute("class")).toContain("self-start");
    expect(host.querySelector(".bg-claude")).toBeNull();
    const engine = host.querySelector("[data-message-engine]");
    expect(text(engine)).toBe("Claude");
    expect(engine?.querySelector('[data-engine-mark="claude"]')).toBeTruthy();
    /* The role and the engine are separate elements: the picture, then the engine's own label. */
    expect(avatar!.contains(engine)).toBe(false);
    expect(text(engine!.parentElement)).toContain(`Claude· ${clock({ hour: "numeric", minute: "numeric", second: "numeric" })}`);
  });

  test("desktop: a conversation with no role draws the agent in the tuxedo", () => {
    const host = mount(<ConversationRoleScope value="neutral"><FeedItem item={prose()} /></ConversationRoleScope>);
    expect(host.querySelector('[data-role-avatar="neutral"]')).toBeTruthy();
    expect(text(host.querySelector("[data-message-engine]"))).toBe("Claude");
  });

  test("phone: the 20 px costume leads the header and the engine glyph and name stay as they were", () => {
    setViewport("narrowPhone");
    const host = mount(<ConversationRoleScope value="verifier"><FeedItem item={prose()} /></ConversationRoleScope>);
    const header = host.querySelector("[data-mobile-message-header]")!;
    const avatar = header.querySelector('[data-role-avatar="verifier"]');
    expect(avatar?.getAttribute("width")).toBe("20");
    expect(header.firstElementChild).toBe(avatar);
    expect(header.querySelector('[data-engine-mark="claude"]')).toBeTruthy();
    expect(text(header.querySelector("[data-mobile-message-speaker]"))).toBe("Claude");
    expect(text(header)).toContain(`· ${clock({ hour: "2-digit", minute: "2-digit" })}`);
  });
});
