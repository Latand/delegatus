import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";

import { installOnboardingDom, jsonResponse, settle } from "@/test-helpers/onboardingDom";

/*
 * The inherited-state notice on the first open (#3304 follow-up, finding F1).
 * The whole chain runs for real: GET /api/onboarding over a fixture state
 * directory, the useOnboarding hook, and the dialog host. The marker on disk
 * is the one the route writes itself, including the automatic existing-install
 * dismissal that used to keep the notice from ever opening on its own.
 */

const env = installOnboardingDom({ url: "http://127.0.0.1/" });
const { NextRequest } = await import("next/server");
const { flushSync } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { GET, PUT } = await import("@/app/api/onboarding/route");
const { OnboardingHost } = await import("@/components/onboarding/OnboardingDialog");
const { openOnboarding, resetOnboardingSnapshotForTests } = await import("@/components/onboarding/useOnboarding");

/* Signed out, so the Engines step marks nothing by itself and every write the tests see is the close. */
const signedIn = { id: "default", label: "Main", authPresent: false, auth: { state: "unauthenticated" } };
const accounts = { claude: { active: "default", accounts: [signedIn] }, codex: { active: "default", accounts: [signedIn] } };

const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-legacy-notice-"));
let sequence = 0;

type Fixture = { config: string; state: string; marker: string; presets: string };

/** A private configuration whose delegatus directory links to an earlier agent-log-viewer one. */
function fixture(options: { linked: boolean; existingState: boolean; marker?: Record<string, unknown> }): Fixture {
  const config = path.join(root, `case-${sequence += 1}`);
  const state = path.join(config, "agent-log-viewer", "state");
  fs.mkdirSync(state, { recursive: true });
  if (options.linked) fs.symlinkSync("agent-log-viewer", path.join(config, "delegatus"));
  const presets = path.join(state, "role-presets.json");
  if (options.existingState) fs.writeFileSync(presets, JSON.stringify({ schemaVersion: 1, overrides: {} }));
  const marker = path.join(state, "onboarding.json");
  if (options.marker) fs.writeFileSync(marker, JSON.stringify(options.marker));
  process.env.XDG_CONFIG_HOME = config;
  process.env.LLV_STATE_DIR = state;
  return { config, state, marker, presets };
}

const noSteps = { engines: null, project: null, telegram: null, orchestrator: null, agents: null, memory: null, phone: null, voice: null, check: null, relay: null };
const old = "2026-08-01T00:00:00.000Z";
const markers = {
  completed: { schemaVersion: 1, completedAt: old, dismissedAt: null, reason: null, steps: { ...noSteps, engines: "done" }, lastHealth: null, walk: "done" },
  dismissed: { schemaVersion: 1, completedAt: null, dismissedAt: old, reason: null, steps: noSteps, lastHealth: null, walk: null },
  upgrade: { schemaVersion: 1, completedAt: null, dismissedAt: old, reason: "existing-install", steps: noSteps, lastHealth: null, walk: null },
} as const;

const puts: unknown[] = [];

/** The real route handlers answer; the other endpoints the dialog reads are inert. */
function routeThroughHandlers() {
  puts.length = 0;
  env.setRoute((url, init) => {
    if (url.endsWith("/api/onboarding")) {
      if (init?.method === "PUT") {
        puts.push(JSON.parse(String(init.body)));
        return (async () => jsonResponse(await (await PUT(new NextRequest("http://127.0.0.1/api/onboarding", { method: "PUT", headers: { "content-type": "application/json", host: "127.0.0.1", origin: "http://127.0.0.1", "sec-fetch-site": "same-origin" }, body: String(init.body) }))).json()))();
      }
      return (async () => jsonResponse(await (await GET()).json()))();
    }
    if (url.includes("/api/accounts/copilot")) return jsonResponse({ accounts: [], active: "", cli: { present: false } });
    if (url.includes("/api/accounts")) return jsonResponse(accounts);
    if (url.includes("/api/roles")) return jsonResponse({ roles: [] });
    return jsonResponse({});
  });
}

function mount() {
  resetOnboardingSnapshotForTests();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const reactRoot = createRoot(host);
  flushSync(() => reactRoot.render(<OnboardingHost />));
  return { host, unmount() { flushSync(() => reactRoot.unmount()); host.remove(); } };
}

const noticeOf = () => document.querySelector("[data-onboarding-legacy-state]");
const dialogOf = () => document.querySelector("[data-onboarding-dialog]");
async function until(done: () => boolean) {
  for (let index = 0; index < 80 && !done(); index += 1) await settle(1);
}
const closeWithEscape = () => flushSync(() => { document.querySelector<HTMLButtonElement>("button[aria-label=\"Close\"]")!.click(); });
const markerOnDisk = (f: Fixture) => (fs.existsSync(f.marker) ? JSON.parse(fs.readFileSync(f.marker, "utf8")) : {}) as Record<string, unknown>;

const settledMarkers = [
  ["the automatic existing-install dismissal", undefined, true],
  ["an old upgrade marker", markers.upgrade, true],
  ["a completed guide", markers.completed, true],
  ["a dismissed guide", markers.dismissed, true],
] as const;

for (const [label, marker, existingState] of settledMarkers) {
  test(`${label}: the first open shows the inherited-state notice by itself, once, and changes no data`, async () => {
    const f = fixture({ linked: true, existingState, marker });
    const presetsBefore = fs.readFileSync(f.presets, "utf8");
    routeThroughHandlers();
    const first = mount();
    await until(() => noticeOf() !== null);
    /* The notice and the clean-start offer, with no manual step. */
    expect(dialogOf()?.getAttribute("data-onboarding-dialog")).toBe("guide");
    expect(noticeOf()?.textContent).toContain("existing state from agent-log-viewer");
    expect(noticeOf()?.querySelector("button")?.textContent).toBe("Start clean instead");
    /* Nothing was written by merely showing it, apart from the route's own upgrade decision. */
    expect(puts).toEqual([]);
    expect(fs.readFileSync(f.presets, "utf8")).toBe(presetsBefore);
    const markerBefore = fs.existsSync(f.marker) ? markerOnDisk(f) : null;
    expect(markerBefore?.legacyNoticeAckedAt ?? null).toBeNull();

    closeWithEscape();
    await until(() => !dialogOf() && Boolean(markerOnDisk(f).legacyNoticeAckedAt));
    expect(dialogOf()).toBeNull();
    /* Closing records the acknowledgement alone: no verdict on the guide. */
    expect(puts).toEqual([{ legacyNoticeAcknowledged: true }]);
    const after = markerOnDisk(f);
    expect(after.legacyNoticeAckedAt).toEqual(expect.any(String));
    expect({ ...after, legacyNoticeAckedAt: null }).toEqual({ ...markerBefore, legacyNoticeAckedAt: null });
    expect(fs.readFileSync(f.presets, "utf8")).toBe(presetsBefore);
    first.unmount();

    /* A later open of the page does not bring it back. */
    puts.length = 0;
    const second = mount();
    await settle(20);
    expect(dialogOf()).toBeNull();
    expect(puts).toEqual([]);
    /* The Setup guide menu still reaches the notice and the clean-start steps. */
    flushSync(() => openOnboarding());
    await until(() => noticeOf() !== null);
    expect(noticeOf()).not.toBeNull();
    second.unmount();
  });
}

test("an acknowledged notice stays quiet when a guide left unfinished reopens by itself", async () => {
  const marker = { ...markers.dismissed, dismissedAt: null, legacyNoticeAckedAt: old };
  fixture({ linked: true, existingState: true, marker });
  routeThroughHandlers();
  const view = mount();
  await until(() => dialogOf() !== null);
  expect(dialogOf()).not.toBeNull();
  expect(noticeOf()).toBeNull();
  view.unmount();
});

test("a first run on inherited state with no marker opens the guide with the notice and closes it into the marker", async () => {
  const f = fixture({ linked: true, existingState: false });
  routeThroughHandlers();
  const view = mount();
  await until(() => noticeOf() !== null);
  expect(noticeOf()).not.toBeNull();
  closeWithEscape();
  await until(() => !dialogOf() && Boolean(markerOnDisk(f).legacyNoticeAckedAt));
  expect(puts.at(-1)).toMatchObject({ dismissed: true, legacyNoticeAcknowledged: true });
  expect(markerOnDisk(f)).toMatchObject({ reason: null, legacyNoticeAckedAt: expect.any(String), dismissedAt: expect.any(String) });
  view.unmount();
});

test("an install with no inherited state behaves as before: a settled marker opens nothing", async () => {
  fixture({ linked: false, existingState: true, marker: markers.upgrade });
  routeThroughHandlers();
  const view = mount();
  await settle(20);
  expect(dialogOf()).toBeNull();
  expect(puts).toEqual([]);
  view.unmount();
});

test("a page that landed on something specific is left alone, and the notice is still owed afterwards", async () => {
  const f = fixture({ linked: true, existingState: true, marker: markers.upgrade });
  routeThroughHandlers();
  window.location.hash = "#conversation-1";
  const landed = mount();
  await settle(20);
  expect(dialogOf()).toBeNull();
  landed.unmount();
  window.location.hash = "";
  expect(markerOnDisk(f).legacyNoticeAckedAt ?? null).toBeNull();
  const plain = mount();
  await until(() => noticeOf() !== null);
  expect(noticeOf()).not.toBeNull();
  plain.unmount();
});
