import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom, jsonResponse, settle } from "@/test-helpers/onboardingDom";
import type { TranscribeBackend, TranscribeBackendInfo } from "@/lib/transcribeBackend";

/*
 * The Voice step (#2004, design §2.6): pick the backend, see where a live
 * backend's key comes from and open «Keys» on it (keys-settings.md §4), and
 * one Check that reports the real answer in a sentence. The routes are stubbed
 * with the answers the real ones give.
 */

const harness = installOnboardingDom();
installActEnv();
/* react-dom decides at load whether the window supports input events, so it
   is loaded only once the window exists. */
const { createRoot } = await import("react-dom/client");
const { VoiceStep } = await import("./VoiceStep");
const { OPEN_KEYS_EVENT } = await import("@/components/keys/openKeys");

/* The route's options in its order (transcribeBackendInfo), OpenAI last. */
function info(backend: TranscribeBackend, over: Partial<Record<TranscribeBackend, { available?: boolean; keySource?: "env" | "file" | null }>> = {}, lockedByEnv = false, choice: { requested?: TranscribeBackend; held?: boolean } = {}): TranscribeBackendInfo {
  return {
    backend,
    requested: choice.requested ?? backend,
    held: choice.held ?? false,
    lockedByEnv,
    options: (["local", "chatgpt", "elevenlabs", "soniox", "openai"] as const).map((id) => ({
      id,
      available: over[id]?.available ?? id === "local",
      keyPath: `/config/${id}`,
      ...(id === "elevenlabs" || id === "soniox" || id === "openai" ? { keySource: over[id]?.keySource ?? null } : {}),
    })),
  };
}

let mounted: { root: Root; host: HTMLDivElement } | null = null;
afterEach(async () => {
  if (mounted) {
    const { root, host } = mounted;
    await act(async () => root.unmount());
    host.remove();
    mounted = null;
  }
});

async function mount(onSkip?: () => void): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(<VoiceStep onSkip={onSkip} />));
  await act(async () => settle());
  return host;
}

const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await act(async () => settle());
};

const sentence = (host: HTMLElement) => host.querySelector("[data-voice-check-result]")?.textContent ?? "";

test("five rows in the store's order, OpenAI last; choosing one saves it at once", async () => {
  let current = info("local");
  harness.setRoute((url, init) => {
    if (url.endsWith("/api/transcribe/backend") && init?.method === "POST") {
      current = info((JSON.parse(String(init.body)) as { backend: TranscribeBackend }).backend);
      return jsonResponse(current);
    }
    if (url.endsWith("/api/transcribe/backend")) return jsonResponse(current);
    return undefined;
  });
  const host = await mount();
  const rows = Array.from(host.querySelectorAll("[data-voice-backend]")).map((row) => row.getAttribute("data-voice-backend"));
  expect(rows).toEqual(["local", "chatgpt", "elevenlabs", "soniox", "openai"]);
  expect(host.querySelector<HTMLInputElement>("[data-voice-backend=local] input[type=radio]")?.checked).toBe(true);
  expect(host.querySelector("[data-voice-key]")).toBeNull();

  await click(host.querySelector("[data-voice-backend=soniox] input[type=radio]"));
  expect(harness.calls.find((call) => call.method === "POST")?.body).toEqual({ backend: "soniox" });
  expect(host.querySelector<HTMLInputElement>("[data-voice-backend=soniox] input[type=radio]")?.checked).toBe(true);
  expect(host.querySelector("[data-voice-key=soniox]")).not.toBeNull();
});

test("a live row has no key field: it says whether the key is set and opens «Keys» on that key", async () => {
  let current = info("soniox");
  harness.setRoute((url) => url.endsWith("/api/transcribe/backend") ? jsonResponse(current) : undefined);
  const asked: unknown[] = [];
  const listen = (event: Event) => asked.push((event as CustomEvent).detail);
  window.addEventListener(OPEN_KEYS_EVENT, listen);
  try {
    const host = await mount();
    const row = host.querySelector("[data-voice-key=soniox]")!;
    expect(row.getAttribute("data-key-source")).toBe("missing");
    expect(row.textContent).toContain("No key yet");
    expect(host.querySelector("[data-voice-backend=soniox] input:not([type=radio])")).toBeNull();
    await click(row.querySelector("[data-voice-open-keys=soniox]"));
    expect(asked).toEqual([{ key: "soniox" }]);

    /* A key saved in «Keys» shows here without reopening the step. */
    current = info("soniox", { soniox: { available: true, keySource: "file" } });
    await act(async () => { window.dispatchEvent(new Event("delegatus:provider-key-changed")); });
    await act(async () => settle());
    expect(host.querySelector("[data-voice-key=soniox]")?.getAttribute("data-key-source")).toBe("file");
    expect(host.textContent).toContain("Key on file");
  } finally {
    window.removeEventListener(OPEN_KEYS_EVENT, listen);
  }
});

test("a key from the environment cannot be edited here, and says which variable", async () => {
  harness.setRoute((url) => url.endsWith("/api/transcribe/backend") ? jsonResponse(info("elevenlabs", { elevenlabs: { available: true, keySource: "env" } })) : undefined);
  const host = await mount();
  expect(host.querySelector("[data-voice-key=elevenlabs]")?.getAttribute("data-key-source")).toBe("env");
  expect(host.textContent).toContain("Key comes from the environment (ELEVENLABS_API_KEY); it cannot be changed here.");
  expect(host.querySelector("[data-voice-open-keys=elevenlabs]")).not.toBeNull();
});

test("the environment lock makes every row read-only", async () => {
  harness.setRoute((url) => url.endsWith("/api/transcribe/backend") ? jsonResponse(info("soniox", { soniox: { available: true, keySource: "env" } }, true)) : undefined);
  const host = await mount();
  expect(host.textContent).toContain("Locked by LLV_TRANSCRIBE_BACKEND on this machine");
  expect(Array.from(host.querySelectorAll<HTMLInputElement>("[data-voice-backend] input[type=radio]")).every((radio) => radio.disabled)).toBe(true);
});

const liveCases: Array<[string, () => Response, string, "success" | "danger"]> = [
  ["a minted token", () => jsonResponse({ token: "short-lived", provider: "soniox" }), "Live dictation works with Soniox.", "success"],
  ["no key (503)", () => jsonResponse({ error: "missing Soniox key" }, 503), "No key on file for Soniox. Add it in Keys.", "danger"],
  ["a refused key (502)", () => jsonResponse({ error: "Soniox token: HTTP 401" }, 502), "Soniox refused the key: Soniox token: HTTP 401.", "danger"],
];
for (const [name, answer, expected, tone] of liveCases) {
  test(`Check for a live backend calls the real token route: ${name}`, async () => {
    harness.setRoute((url, init) => {
      if (url.endsWith("/api/transcribe/token") && init?.method === "POST") return answer();
      if (url.endsWith("/api/transcribe/backend")) return jsonResponse(info("soniox", { soniox: { available: true, keySource: "file" } }));
      return undefined;
    });
    const host = await mount();
    await click(host.querySelector("[data-voice-check]"));
    expect(harness.calls.some((call) => call.url.endsWith("/api/transcribe/token") && call.method === "POST")).toBe(true);
    expect(sentence(host)).toBe(expected);
    expect(host.querySelector("[data-voice-check-result]")?.getAttribute("data-tone")).toBe(tone);
    /* The minted token is discarded, never rendered. */
    expect(host.innerHTML).not.toContain("short-lived");
  });
}

const batchCases: Array<[TranscribeBackend, boolean, string]> = [
  ["local", true, "Dictation works with Faster Whisper on this computer. Speech is transcribed after you stop."],
  ["local", false, "Faster Whisper is not installed on this computer."],
  ["chatgpt", true, "Dictation works through your Codex sign-in. Speech is transcribed after you stop."],
  ["chatgpt", false, "No signed-in Codex account."],
];
for (const [backend, available, expected] of batchCases) {
  test(`Check for ${backend} (${available ? "available" : "unavailable"}) reads the backend report`, async () => {
    harness.setRoute((url) => url.endsWith("/api/transcribe/backend") ? jsonResponse(info(backend, { [backend]: { available } })) : undefined);
    const host = await mount();
    await click(host.querySelector("[data-voice-check]"));
    expect(harness.calls.some((call) => call.url.endsWith("/api/transcribe/token"))).toBe(false);
    expect(sentence(host)).toBe(expected);
  });
}

test("a check the server cannot answer says so in a sentence", async () => {
  let reads = 0;
  harness.setRoute((url) => {
    if (!url.endsWith("/api/transcribe/backend")) return undefined;
    reads += 1;
    return reads === 1 ? jsonResponse(info("local")) : jsonResponse({ error: "boom" }, 500);
  });
  const host = await mount();
  await click(host.querySelector("[data-voice-check]"));
  expect(sentence(host)).toBe("Could not check: HTTP 500.");
});

test("Keep the local default skips the step and leaves the backend alone", async () => {
  harness.setRoute((url) => url.endsWith("/api/transcribe/backend") ? jsonResponse(info("local")) : undefined);
  const skipped: string[] = [];
  const host = await mount(() => skipped.push("skip"));
  await click(host.querySelector("[data-voice-skip]"));
  expect(skipped).toEqual(["skip"]);
  expect(harness.calls.some((call) => call.method === "POST")).toBe(false);
});

test("Keep the local default is offered only while local is the chosen backend", async () => {
  harness.setRoute((url) => url.endsWith("/api/transcribe/backend") ? jsonResponse(info("soniox")) : undefined);
  const host = await mount(() => {});
  expect(host.querySelector("[data-voice-backend='soniox'][data-selected]")).not.toBeNull();
  expect(host.querySelector("[data-voice-skip]")).toBeNull();
});

test("without an OpenAI key its row cannot be chosen, says so, and opens «Keys» on the OpenAI key", async () => {
  harness.setRoute((url) => url.endsWith("/api/transcribe/backend") ? jsonResponse(info("soniox")) : undefined);
  const asked: unknown[] = [];
  const listen = (event: Event) => asked.push((event as CustomEvent).detail);
  window.addEventListener(OPEN_KEYS_EVENT, listen);
  try {
    const host = await mount();
    const row = host.querySelector("[data-voice-backend=openai]")!;
    expect(row.querySelector<HTMLInputElement>("input[type=radio]")!.disabled).toBe(true);
    expect(row.querySelector("[data-voice-openai-reason=missing]")!.textContent).toBe("No OpenAI key yet");
    const add = row.querySelector("[data-voice-open-keys=openai]")!;
    expect(add.closest("label")).toBeNull();
    await click(add);
    expect(asked).toEqual([{ key: "openai" }]);
    expect(harness.calls.some((call) => call.method === "POST")).toBe(false);
  } finally {
    window.removeEventListener(OPEN_KEYS_EVENT, listen);
  }
});

test("an OpenAI choice made before the key was removed waits, amber, while the previous provider serves dictation", async () => {
  harness.setRoute((url) => url.endsWith("/api/transcribe/backend") ? jsonResponse(info("soniox", { soniox: { available: true, keySource: "file" } }, false, { requested: "openai", held: true })) : undefined);
  const host = await mount();
  expect(host.querySelector<HTMLInputElement>("[data-voice-backend=soniox] input[type=radio]")!.checked).toBe(true);
  const row = host.querySelector("[data-voice-backend=openai]")!;
  expect(row.querySelector<HTMLInputElement>("input[type=radio]")!.disabled).toBe(true);
  expect(row.querySelector("[data-voice-openai-reason=held]")!.textContent).toBe("Chosen before the key was removed");
});

test("a held OpenAI choice is let go by pressing the provider serving dictation now, and a choice already kept sends nothing", async () => {
  let current = info("soniox", { soniox: { available: true, keySource: "file" } }, false, { requested: "openai", held: true });
  harness.setRoute((url, init) => {
    if (url.endsWith("/api/transcribe/backend") && init?.method === "POST") {
      current = info((JSON.parse(String(init.body)) as { backend: TranscribeBackend }).backend, { soniox: { available: true, keySource: "file" } });
      return jsonResponse(current);
    }
    if (url.endsWith("/api/transcribe/backend")) return jsonResponse(current);
    return undefined;
  });
  const host = await mount();
  const soniox = () => host.querySelector<HTMLInputElement>("[data-voice-backend=soniox] input[type=radio]")!;
  expect(soniox().checked).toBe(true);
  await click(soniox());
  expect(harness.calls.filter((call) => call.method === "POST").map((call) => call.body)).toEqual([{ backend: "soniox" }]);
  expect(soniox().checked).toBe(true);
  expect(host.querySelector("[data-voice-openai-reason=held]")).toBeNull();
  await click(soniox());
  expect(harness.calls.filter((call) => call.method === "POST").length).toBe(1);
});

test("with the OpenAI key, OpenAI is chosen like any live provider and its check asks for a live token", async () => {
  let current = info("local", { openai: { available: true, keySource: "file" } });
  harness.setRoute((url, init) => {
    if (url.endsWith("/api/transcribe/backend") && init?.method === "POST") {
      current = info((JSON.parse(String(init.body)) as { backend: TranscribeBackend }).backend, { openai: { available: true, keySource: "file" } });
      return jsonResponse(current);
    }
    if (url.endsWith("/api/transcribe/backend")) return jsonResponse(current);
    if (url.endsWith("/api/transcribe/token")) return jsonResponse({ token: "fixture", provider: "openai", expiresAt: 2_000_000_000 });
    return undefined;
  });
  const host = await mount();
  await click(host.querySelector("[data-voice-backend=openai] input[type=radio]"));
  expect(harness.calls.find((call) => call.method === "POST")?.body).toEqual({ backend: "openai" });
  expect(host.querySelector("[data-voice-key=openai]")?.getAttribute("data-key-source")).toBe("file");
  await click(host.querySelector("[data-voice-check]"));
  expect(sentence(host)).toBe("Live dictation works with OpenAI.");
});
