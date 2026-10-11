import { afterEach, beforeEach, expect, test } from "bun:test";
import { act, type ReactNode } from "react";
import type { Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom, jsonResponse, settle, typeInto } from "@/test-helpers/onboardingDom";

/*
 * «Створити клона» in a paired relay's card (docs/research/celestia-clone-creation.md,
 * variant 1): dark until the relay's descriptor lists clone_create; the form
 * with a random name and the username derived from it; «Створити в Telegram»
 * sends the request and points the window opened in the click at the t.me
 * link; the wait names the paired account, polls the request and cancels it;
 * a created clone's row is marked «Новий» and takes the signed-in engine,
 * answered here; a request that ended, and the daily limit, say so plainly.
 */

const harness = installOnboardingDom();
installActEnv();
const { createRoot } = await import("react-dom/client");
const { ExternalRelaySection } = await import("./ExternalRelaySection");
const { resetEngineAccountsStoresForTests } = await import("@/hooks/useEngineAccounts");
const { setLocale } = await import("@/lib/i18n");

const OWNER = { namespace: "example", id: "owner-1", display_name: "Person A", handle: "@person_a" };
const CREATE_URL = "https://t.me/newbot/manager_bot/nichna_sova_bot?name=%D0%9D";
const target = (over: Record<string, unknown> = {}) => ({
  id: "bot-1", name: "Support bot", answered_by: "install", fallback: "service", enabled: true,
  engine: "claude", model: "claude-opus-5-5", effort: null, project: null, concurrency: 1, hardCapMinutes: 30, ...over,
});
const relay = (over: Record<string, unknown> = {}) => ({
  id: "relay-1", origin: "https://relay.example", name: "Celestia", description: "",
  owner: OWNER, pairedAt: "2026-10-11T10:00:00.000Z", paused: false, targets: [target()], features: ["clone_create"], ...over,
});
const request = (over: Record<string, unknown> = {}) => ({
  request_id: "req-1", create_url: CREATE_URL, expires_at: new Date(Date.now() + 600_000).toISOString(),
  name: "Нічна Сова", username: "nichna_sova_bot", requestedAt: new Date().toISOString(), ...over,
});
const signedIn = (id: string) => ({ id, label: id, kind: "managed", authPresent: true, authHealth: "authenticated", loginPending: false, loginState: "authenticated", deviceAuth: null });

let state: { relays: unknown[]; pending: unknown[]; status: unknown[] };
let mounted: { root: Root; host: HTMLDivElement } | null = null;
let opened: { href: string; closed: boolean }[] = [];
const realOpen = window.open;
beforeEach(() => {
  opened = [];
  window.open = (() => {
    const win = { opener: {}, closed: false, document: { body: { textContent: "" } }, location: { href: "about:blank" }, close() { win.closed = true; } };
    opened.push({ get href() { return win.location.href; }, get closed() { return win.closed; } });
    return win;
  }) as unknown as typeof window.open;
});
afterEach(async () => {
  window.open = realOpen;
  if (mounted) {
    const { root, host } = mounted;
    await act(async () => root.unmount());
    host.remove();
    mounted = null;
  }
  setLocale("en");
});
async function mount(node: ReactNode): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(node));
  await act(async () => settle());
  return host;
}
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await act(async () => settle());
};
const submit = async (host: HTMLElement) => {
  const form = host.querySelector<HTMLFormElement>("[data-clone-form]")!;
  await act(async () => form.requestSubmit());
  await act(async () => settle());
};
function route(extra?: (url: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined) {
  resetEngineAccountsStoresForTests();
  harness.setRoute((url, init) => {
    const answer = extra?.(url, init);
    if (answer) return answer;
    if (url.endsWith("/api/accounts")) return jsonResponse({ claude: { active: "", accounts: [signedIn("main")] }, codex: { active: "", accounts: [] } });
    if (url.includes("/api/accounts/")) return jsonResponse({ cli: { present: false, reason: null }, active: "", accounts: [] });
    if (url === "/api/external-relay") return jsonResponse(state);
    if (url === "/api/external-relay/known") return jsonResponse({ known: [] });
    return undefined;
  });
}
const BASE = "/api/external-relay/relays/relay-1";

test("dark until the descriptor lists clone_create: no block, and the empty card keeps its line", async () => {
  state = { relays: [relay({ features: ["requester_context"] }), relay({ id: "relay-2", features: undefined, targets: [] })], pending: [], status: [] };
  route();
  const host = await mount(<ExternalRelaySection />);
  expect(host.querySelectorAll("[data-external-relay]").length).toBe(2);
  expect(host.querySelector("[data-clone-open], [data-clone-empty], [data-clone-form]")).toBeNull();
  expect(host.textContent).toContain("The relay service lists no targets for you yet.");
});

test("with no clones, the dashed block opens the form with a random name and its derived address, which stops following once edited", async () => {
  setLocale("uk");
  state = { relays: [relay({ targets: [] })], pending: [], status: [] };
  route();
  const host = await mount(<ExternalRelaySection />);
  const empty = host.querySelector("[data-clone-empty]")!;
  expect(empty.textContent).toContain("У вас ще немає клонів Celestia.");
  expect(host.textContent).not.toContain("Сервіс ще не показує");
  await click(empty.querySelector("[data-clone-open]"));
  const name = host.querySelector<HTMLInputElement>("[data-clone-name]")!;
  const username = host.querySelector<HTMLInputElement>("[data-clone-username]")!;
  expect(name.value.split(" ").length).toBe(2);
  expect(username.value).toMatch(/^[a-z][a-z0-9_]*_bot$/);
  await act(async () => typeInto(name, "Нічна Сова"));
  expect(username.value).toBe("nichna_sova_bot");
  const before = name.value;
  await click(host.querySelector("[data-clone-random]"));
  expect(name.value).not.toBe(before);
  await act(async () => typeInto(username, "@my_owl_bot"));
  expect(username.value).toBe("my_owl_bot");
  await act(async () => typeInto(name, "Тихий Лис"));
  expect(username.value).toBe("my_owl_bot");
  await act(async () => typeInto(username, "owl"));
  expect(host.querySelector("[data-clone-username-hint]")?.textContent).toContain("закінчується на «bot»");
  expect(host.querySelector<HTMLButtonElement>("[data-clone-submit]")!.disabled).toBe(true);
  await click(host.querySelector("[data-clone-close]"));
  expect(host.querySelector("[data-clone-empty]")).toBeTruthy();
});

test("Create in Telegram sends name, address and the chosen candidate, opens the t.me link, and the wait names the paired account", async () => {
  state = { relays: [relay()], pending: [], status: [] };
  let created: unknown = null;
  route((url, init) => {
    if (url === `${BASE}/clone-avatars` && init?.method === "POST")
      return jsonResponse({ candidates: [{ storage_key: "a/1.png", preview: "data:image/jpeg;base64,AAAA" }, { storage_key: "a/2.png", preview: "data:image/jpeg;base64,BBBB" }] });
    if (url === `${BASE}/clone-requests` && init?.method === "POST") {
      created = JSON.parse(String(init.body));
      return jsonResponse({ request: request() }, 201);
    }
    if (url === `${BASE}/clone-requests/req-1`) return jsonResponse({ request: { status: "pending" } });
    return undefined;
  });
  const host = await mount(<ExternalRelaySection />);
  await click(host.querySelector("[data-clone-open]"));
  await act(async () => typeInto(host.querySelector<HTMLInputElement>("[data-clone-name]")!, "Night Owl"));
  await click(host.querySelector("[data-clone-generate]"));
  expect(harness.calls.find((call) => call.url === `${BASE}/clone-avatars`)?.body).toEqual({ prompt: expect.stringContaining("\"Night Owl\"") });
  const candidates = host.querySelectorAll("[data-clone-candidate]");
  expect(candidates.length).toBe(2);
  expect(candidates[0]!.getAttribute("aria-pressed")).toBe("true");
  await click(candidates[1]);
  expect(candidates[1]!.getAttribute("aria-pressed")).toBe("true");
  await submit(host);
  expect(created).toEqual({ name: "Night Owl", username: "night_owl_bot", photo: { kind: "candidate", storage_key: "a/2.png" } });
  expect(opened.map((win) => [win.href, win.closed])).toEqual([[CREATE_URL, false]]);
  const waiting = host.querySelector("[data-clone-waiting]")!;
  expect(waiting.querySelector("[data-clone-owner]")?.textContent).toBe("Confirm the new bot in Telegram from the account Person A (@person_a). The clone appears here on its own within seconds.");
  expect(waiting.querySelector("[data-clone-open-again]")?.getAttribute("href")).toBe(CREATE_URL);
  expect(host.querySelector("[data-clone-pending-row]")?.textContent).toContain("Нічна Сова");
  expect(harness.calls.some((call) => call.url === `${BASE}/clone-requests/req-1` && call.method === "GET")).toBe(true);
  expect(host.querySelector("[data-clone-form]")).toBeNull();
});

test("a stored request resumes the wait, and cancel deletes it and returns to the form", async () => {
  state = { relays: [relay({ cloneRequest: request() })], pending: [], status: [] };
  route((url, init) => {
    if (url === `${BASE}/clone-requests/req-1` && init?.method === "DELETE") return new Response(null, { status: 204 });
    if (url === `${BASE}/clone-requests/req-1`) return jsonResponse({ request: { status: "pending" } });
    return undefined;
  });
  const host = await mount(<ExternalRelaySection />);
  expect(host.querySelector("[data-clone-waiting]")?.getAttribute("data-clone-waiting")).toBe("req-1");
  await click(host.querySelector("[data-clone-cancel]"));
  expect(harness.calls.some((call) => call.url === `${BASE}/clone-requests/req-1` && call.method === "DELETE")).toBe(true);
  expect(host.querySelector("[data-clone-waiting]")).toBeNull();
  expect(host.querySelector("[data-clone-form]")).toBeTruthy();
});

test("created: the new row is marked New, takes Claude with its default model, and is answered here; Open in Telegram links the bot", async () => {
  state = { relays: [relay({ cloneRequest: request() })], pending: [], status: [] };
  route((url, init) => {
    if (url === `${BASE}/clone-requests/req-1`) {
      state = { relays: [relay({ targets: [target(), target({ id: "fresh", name: "Нічна Сова", engine: null, model: null, answered_by: "service" })] })], pending: [], status: [] };
      return jsonResponse({ request: { status: "created", target_id: "fresh", username: "nichna_sova_bot" } });
    }
    if (url === BASE && init?.method === "PATCH") {
      state = { relays: [relay({ targets: [target(), target({ id: "fresh", name: "Нічна Сова", answered_by: "service" })] })], pending: [], status: [] };
      return jsonResponse({ relay: state.relays[0] });
    }
    if (url === `${BASE}/targets/fresh` && init?.method === "PATCH") {
      state = { relays: [relay({ targets: [target(), target({ id: "fresh", name: "Нічна Сова" })] })], pending: [], status: [] };
      return jsonResponse({ target: {} });
    }
    return undefined;
  });
  const host = await mount(<ExternalRelaySection />);
  await act(async () => settle(20));
  const patches = harness.calls.filter((call) => call.method === "PATCH");
  expect(patches.map((call) => [call.url, call.body])).toEqual([
    [BASE, { target: { id: "fresh", engine: "claude", model: expect.any(String) } }],
    [`${BASE}/targets/fresh`, { answered_by: "install" }],
  ]);
  const row = host.querySelector("[data-external-relay-target='fresh']")!;
  expect(row.hasAttribute("data-fresh")).toBe(true);
  expect(row.querySelector("[data-external-relay-fresh]")?.textContent).toBe("New");
  expect(host.querySelector("[data-external-relay-target='bot-1'] [data-external-relay-fresh]")).toBeNull();
  const created = host.querySelector("[data-clone-created]")!;
  expect(created.textContent).toContain("Clone “Нічна Сова” created: @nichna_sova_bot. This install answers it.");
  expect(created.querySelector("[data-clone-open-bot]")?.getAttribute("href")).toBe("https://t.me/nichna_sova_bot");
  expect(host.querySelector("[data-clone-open]")).toBeTruthy();
  expect(host.querySelector("[data-clone-pending-row]")).toBeNull();
});

test("created with photo_failed keeps the clone and says the photo was not set", async () => {
  state = { relays: [relay({ cloneRequest: request() })], pending: [], status: [] };
  route((url) => url === `${BASE}/clone-requests/req-1` ? jsonResponse({ request: { status: "created", target_id: "bot-1", reason: "photo_failed" } }) : undefined);
  const host = await mount(<ExternalRelaySection />);
  expect(host.querySelector("[data-clone-photo-failed]")?.textContent).toBe("The photo could not be set. You can change it in Telegram.");
});

test("expired and failed end the wait plainly with Try again", async () => {
  for (const [status, text] of [["expired", "The time to create it in Telegram ran out; no clone was created."], ["failed", "The service could not create the clone."]] as const) {
    state = { relays: [relay({ cloneRequest: request() })], pending: [], status: [] };
    route((url) => url === `${BASE}/clone-requests/req-1` ? jsonResponse({ request: { status, ...(status === "failed" ? { reason: "bot limit reached" } : {}) } }) : undefined);
    const host = await mount(<ExternalRelaySection />);
    const ended = host.querySelector(`[data-clone-ended='${status}']`)!;
    expect(ended.textContent).toContain(text);
    if (status === "failed") expect(ended.textContent).toContain("bot limit reached");
    await click(ended.querySelector("[data-clone-again]"));
    expect(host.querySelector("[data-clone-form]")).toBeTruthy();
    const { root } = mounted!;
    await act(async () => root.unmount());
    mounted!.host.remove();
    mounted = null;
  }
});

test("the daily limit, for photos and for the request, is said plainly and closes the window it opened", async () => {
  state = { relays: [relay()], pending: [], status: [] };
  route((url, init) => {
    if (init?.method === "POST" && (url === `${BASE}/clone-avatars` || url === `${BASE}/clone-requests`)) return jsonResponse({ error: "clone_daily_limit" }, 429);
    return undefined;
  });
  const host = await mount(<ExternalRelaySection />);
  await click(host.querySelector("[data-clone-open]"));
  await click(host.querySelector("[data-clone-generate]"));
  expect(host.querySelector("[data-clone-form] [role=alert]")?.textContent).toBe("The service's limit for today is used up. Try again tomorrow.");
  await submit(host);
  expect(host.querySelector("[data-clone-form] [role=alert]")?.textContent).toBe("The service's limit for today is used up. Try again tomorrow.");
  expect(opened.map((win) => win.closed)).toEqual([true]);
  expect(host.querySelector("[data-clone-waiting]")).toBeNull();
});

test("an upload over 8 MB is refused before it is read; a readable one shows as the chosen photo and goes as an upload", async () => {
  state = { relays: [relay()], pending: [], status: [] };
  let created: { photo?: { kind: string; data: string } } | null = null;
  route((url, init) => {
    if (url === `${BASE}/clone-requests` && init?.method === "POST") { created = JSON.parse(String(init.body)); return jsonResponse({ request: request() }, 201); }
    if (url === `${BASE}/clone-requests/req-1` && init?.method === "DELETE") return new Response(null, { status: 204 });
    if (url === `${BASE}/clone-requests/req-1`) return jsonResponse({ request: { status: "pending" } });
    return undefined;
  });
  const host = await mount(<ExternalRelaySection />);
  await click(host.querySelector("[data-clone-open]"));
  const input = host.querySelector<HTMLInputElement>("[data-clone-upload-input]")!;
  const choose = async (file: File) => {
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event("change", { bubbles: true })));
    await act(async () => settle(20));
  };
  await choose(new File([new Uint8Array(8 * 1024 * 1024 + 1)], "big.png", { type: "image/png" }));
  expect(host.querySelector("[data-clone-form] [role=alert]")?.textContent).toBe("The image is too large. Choose a file up to 8 MB.");
  await choose(new File([new Uint8Array([1, 2, 3])], "owl.png", { type: "image/png" }));
  expect(host.querySelector("[data-clone-photo]")?.getAttribute("data-clone-photo")).toBe("upload");
  expect(host.querySelector("[data-clone-uploaded] img")).toBeTruthy();
  await submit(host);
  expect(created!.photo).toEqual({ kind: "upload", data: "AQID" });
  await click(host.querySelector("[data-clone-cancel]"));
  await click(host.querySelector("[data-clone-no-photo]"));
  expect(host.querySelector("[data-clone-photo]")?.getAttribute("data-clone-photo")).toBe("none");
});
