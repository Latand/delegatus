import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom, jsonResponse, settle, typeInto } from "@/test-helpers/onboardingDom";
import type { TranscribeBackend, TranscribeBackendInfo } from "@/lib/transcribeBackend";

/*
 * The Voice step (#2004, design §2.6): pick the backend, paste a live key, and
 * one Check that reports the real answer in a sentence. The routes are stubbed
 * with the answers the real ones give; the key typed here must never be shown
 * again once it is saved.
 */

const harness = installOnboardingDom();
installActEnv();
/* react-dom decides at load whether the window supports input events, so it
   is loaded only once the window exists. */
const { createRoot } = await import("react-dom/client");
const { VoiceStep } = await import("./VoiceStep");

const FAKE_KEY = ["fixture", "voice", "value", "42"].join("-");

function info(backend: TranscribeBackend, over: Partial<Record<TranscribeBackend, { available?: boolean; keySource?: "env" | "file" | null }>> = {}, lockedByEnv = false): TranscribeBackendInfo {
  return {
    backend,
    lockedByEnv,
    options: (["local", "chatgpt", "elevenlabs", "soniox"] as const).map((id) => ({
      id,
      available: over[id]?.available ?? id === "local",
      keyPath: `/config/${id}`,
      ...(id === "elevenlabs" || id === "soniox" ? { keySource: over[id]?.keySource ?? null } : {}),
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

test("four rows in the store's order; choosing one saves it at once", async () => {
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
  expect(rows).toEqual(["local", "chatgpt", "elevenlabs", "soniox"]);
  expect(host.querySelector<HTMLInputElement>("[data-voice-backend=local] input[type=radio]")?.checked).toBe(true);
  expect(host.querySelector("[data-voice-key-field]")).toBeNull();

  await click(host.querySelector("[data-voice-backend=soniox] input[type=radio]"));
  expect(harness.calls.find((call) => call.method === "POST")?.body).toEqual({ backend: "soniox" });
  expect(host.querySelector<HTMLInputElement>("[data-voice-backend=soniox] input[type=radio]")?.checked).toBe(true);
  expect(host.querySelector("[data-voice-key-field=soniox]")).not.toBeNull();
});

test("a saved key goes to the key route and is never shown again", async () => {
  let current = info("soniox");
  harness.setRoute((url, init) => {
    if (url.endsWith("/api/transcribe/key") && init?.method === "PUT") {
      current = info("soniox", { soniox: { available: true, keySource: "file" } });
      return jsonResponse(current);
    }
    if (url.endsWith("/api/transcribe/backend")) return jsonResponse(current);
    return undefined;
  });
  const host = await mount();
  const field = host.querySelector<HTMLInputElement>("[data-voice-key-field=soniox] input")!;
  expect(field.type).toBe("password");
  await act(async () => typeInto(field, `  ${FAKE_KEY}  `));
  await click(host.querySelector("[data-voice-key-save]"));
  expect(harness.calls.find((call) => call.method === "PUT")?.body).toEqual({ provider: "soniox", key: FAKE_KEY });
  expect(host.textContent).toContain("Key saved. It is never shown again.");
  expect(host.textContent).toContain("Key on file");
  expect(host.innerHTML).not.toContain(FAKE_KEY);
  expect(host.querySelector("[data-voice-key-field=soniox] input")).toBeNull();

  /* Replace opens an empty field; it never fills in what is on file. */
  await click(host.querySelector("[data-voice-key-replace]"));
  expect(host.querySelector<HTMLInputElement>("[data-voice-key-field=soniox] input")?.value).toBe("");
});

test("a key from the environment cannot be edited here, and says which variable", async () => {
  harness.setRoute((url) => url.endsWith("/api/transcribe/backend") ? jsonResponse(info("elevenlabs", { elevenlabs: { available: true, keySource: "env" } })) : undefined);
  const host = await mount();
  expect(host.querySelector("[data-voice-key-field=elevenlabs] input")).toBeNull();
  expect(host.textContent).toContain("Key comes from the environment (ELEVENLABS_API_KEY); it cannot be changed here.");
});

test("the environment lock makes every row read-only", async () => {
  harness.setRoute((url) => url.endsWith("/api/transcribe/backend") ? jsonResponse(info("soniox", { soniox: { available: true, keySource: "env" } }, true)) : undefined);
  const host = await mount();
  expect(host.textContent).toContain("Locked by LLV_TRANSCRIBE_BACKEND on this machine");
  expect(Array.from(host.querySelectorAll<HTMLInputElement>("[data-voice-backend] input[type=radio]")).every((radio) => radio.disabled)).toBe(true);
});

const liveCases: Array<[string, () => Response, string, "success" | "danger"]> = [
  ["a minted token", () => jsonResponse({ token: "short-lived", provider: "soniox" }), "Live dictation works with Soniox.", "success"],
  ["no key (503)", () => jsonResponse({ error: "missing Soniox key" }, 503), "No key on file for Soniox. Paste it above and save.", "danger"],
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
