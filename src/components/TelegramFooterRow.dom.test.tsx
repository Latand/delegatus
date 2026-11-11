import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom, jsonResponse } from "@/test-helpers/onboardingDom";

/*
 * The sidebar's Telegram row (install-and-onboarding §5.4): with a bot connected and the personal account not, the
 * row says «Bot connected» with the connected dot. It reads the bot once when it mounts and once after its panel
 * closes, never on an interval of its own.
 */

const dom = installOnboardingDom();
installActEnv();
const { createRoot } = await import("react-dom/client");
const { TelegramFooterRow } = await import("./TelegramConnect");

let phase = "disconnected";
let botConnected = false;
dom.setRoute((url) => {
  if (url.startsWith("/api/telegram/bot")) return jsonResponse({ bot: { connected: botConnected, bot: botConnected ? { name: "Report Bot", username: "report_test_bot", canReadAllGroupMessages: false, canJoinGroups: true } : null, receiving: "polling", lastUpdateAt: null, lastCheckedAt: null, chats: [], limits: [] } });
  if (url.startsWith("/api/telegram")) return jsonResponse({ telegram: { phase, login: null, identity: null, error: null, health: null, lastCheckedAt: null } });
  return undefined;
});

let mounted: { root: Root; host: HTMLDivElement } | null = null;
afterEach(async () => {
  if (mounted) { await act(async () => mounted!.root.unmount()); mounted.host.remove(); mounted = null; }
  phase = "disconnected"; botConnected = false;
  dom.calls.length = 0;
});

/* Polls an observable condition; the loop yields a macrotask, it never sleeps for a fixed time. */
async function until(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 400 && !check(); attempt += 1) await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  expect(check()).toBe(true);
}

async function mount() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(<TelegramFooterRow density="line" />));
  await until(() => botReads() >= 1);
  await until(() => (host.textContent ?? "").length > 0);
  return host;
}
const botReads = () => dom.calls.filter((call) => call.url.startsWith("/api/telegram/bot")).length;
const dotOf = (host: HTMLElement) => host.querySelector("button span[aria-hidden]") as HTMLElement;

test("a bot connected while the personal account is not reads «Bot connected» with the connected dot", async () => {
  botConnected = true;
  const host = await mount();
  expect(host.textContent).toContain("Bot connected");
  expect(host.textContent).not.toContain("Not connected");
  expect(dotOf(host).getAttribute("style")).toContain("var(--color-success)");
});

test("with no bot and no account the row keeps saying Not connected", async () => {
  const host = await mount();
  expect(host.textContent).toContain("Not connected");
  expect(host.textContent).not.toContain("Bot connected");
});

test("a connected personal account keeps its own word, bot or not", async () => {
  phase = "connected"; botConnected = true;
  const host = await mount();
  expect(host.textContent).toContain("Connected");
  expect(host.textContent).not.toContain("Bot connected");
});

test("the row reads the bot once on mount and again after its panel closes, and no timer it plants reads the bot", async () => {
  /* Collect every timer of seconds the mounted row plants, then fire each one: a poll of the bot would read it again. */
  const realInterval = globalThis.setInterval;
  const realTimeout = globalThis.setTimeout;
  const planted: (() => void)[] = [];
  globalThis.setInterval = ((handler: TimerHandler, delay?: number, ...rest: unknown[]) => { planted.push(handler as () => void); return realInterval(handler as () => void, delay, ...rest); }) as unknown as typeof setInterval;
  globalThis.setTimeout = ((handler: TimerHandler, delay?: number, ...rest: unknown[]) => { if ((delay ?? 0) >= 1000) planted.push(handler as () => void); return realTimeout(handler as () => void, delay, ...rest); }) as unknown as typeof setTimeout;
  let host: HTMLElement;
  try {
    host = await mount();
  } finally {
    globalThis.setInterval = realInterval;
    globalThis.setTimeout = realTimeout;
  }
  expect(botReads()).toBe(1);
  const firedAt = dom.calls.length;
  await act(async () => { for (const handler of planted) handler(); });
  await until(() => dom.calls.length > firedAt);
  expect(dom.calls.slice(firedAt).filter((call) => call.url.startsWith("/api/telegram/bot"))).toEqual([]);
  expect(botReads()).toBe(1);
  const trigger = host.querySelector("button[aria-haspopup=dialog]") as HTMLButtonElement;
  await act(async () => trigger.click());
  await until(() => botReads() >= 2);
  botConnected = true;
  const whileOpen = botReads();
  await act(async () => trigger.click());
  await until(() => botReads() === whileOpen + 1);
  await until(() => (host.textContent ?? "").includes("Bot connected"));
});
