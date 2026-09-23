import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom, jsonResponse, settle } from "@/test-helpers/onboardingDom";

/*
 * The Tour step (#1876 slice 3, design §2.4): four cards that say what the
 * product is, and a "Start here" band whose Create opens the chosen project's
 * orchestrator draft on Claude Opus at the chosen effort. Create spawns
 * nothing: the draft's own Confirm stays the paid action.
 */

const harness = installOnboardingDom();
installActEnv();
const { createRoot } = await import("react-dom/client");
const { TourStep } = await import("./TourStep");
const { onOrchestratorDraftRequest } = await import("@/components/orchestrator/draftPrefill");
const { readSeatDraftField } = await import("@/components/mobile/orchestratorDraftStorage");
const { resetOrchestratorSeatCacheForTests } = await import("@/components/orchestrator/useOrchestratorSeat");

const PROJECTS = [
  { project: "repo-alpha", name: "alpha-service" },
  { project: "repo-beta", name: "beta-app" },
];

const seated = (project: string) => ({
  seat: { project, mandate: "m", state: "active", seatEpoch: 1, conversationId: "conv-1", intent: { clientRequestId: "req-1", mode: "spawn" } },
  exists: true,
});

let mounted: { root: Root; host: HTMLDivElement } | null = null;
afterEach(async () => {
  if (mounted) {
    const { root, host } = mounted;
    await act(async () => root.unmount());
    host.remove();
    mounted = null;
  }
  resetOrchestratorSeatCacheForTests();
  window.sessionStorage.clear();
});

type Props = Parameters<typeof TourStep>[0];
async function mount(over: Partial<Props> = {}): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  const props: Props = { projects: PROJECTS, initialProject: "repo-beta", claudeConnected: true, checkMinutes: 5, onCreated: () => {}, ...over };
  await act(async () => root.render(<TourStep {...props} />));
  await act(async () => settle());
  return host;
}

const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await act(async () => settle());
};

test("four cards say what the product is, in its own words, each with a picture", async () => {
  harness.setRoute((url) => url.includes("/api/orchestrator/seat") ? jsonResponse({ seat: null, exists: true }) : undefined);
  const host = await mount();
  const cards = Array.from(host.querySelectorAll("[data-tour-card]"));
  expect(cards.map((element) => element.getAttribute("data-tour-card"))).toEqual(["1", "2", "3", "4"]);
  expect(cards.every((element) => element.querySelector("svg"))).toBe(true);
  expect(cards[0]!.textContent).toContain("An orchestrator for coding agents");
  expect(cards[0]!.textContent).toContain("The work is tasks on each project's board");
  expect(cards[1]!.textContent).toContain("Delegatus wakes it every 5 minutes");
  expect(cards[2]!.textContent).toContain("Fail sends it back for another round");
  /* The corner's own word, so the card and the screen say the same thing. */
  expect(cards[3]!.textContent).toContain("“Needs you” in the corner");
  expect(host.querySelector("[data-tour-start] svg")).not.toBeNull();
  const links = Array.from(host.querySelectorAll("[data-tour-links] a")).map((anchor) => anchor.getAttribute("href"));
  expect(links).toEqual([
    "https://github.com/Latand/live-log-viewer-next#how-agents-are-driven",
    "https://github.com/Latand/live-log-viewer-next/blob/main/docs/orchestrator.md",
  ]);
});

test("Create opens the chosen project's draft on Opus at the chosen effort, and spawns nothing", async () => {
  harness.setRoute((url) => url.includes("/api/orchestrator/seat") ? jsonResponse({ seat: null, exists: true }) : undefined);
  const requests: unknown[] = [];
  const stop = onOrchestratorDraftRequest((request) => requests.push(request));
  const created: string[] = [];
  try {
    const host = await mount({ onCreated: () => created.push("closed") });
    const select = host.querySelector<HTMLSelectElement>("[data-tour-project]")!;
    expect(Array.from(select.options).map((option) => option.value)).toEqual(["repo-alpha", "repo-beta"]);
    expect(select.value).toBe("repo-beta");
    /* High is the recommended default. */
    expect(host.querySelector("[data-tour-effort=high]")?.getAttribute("aria-checked")).toBe("true");
    await click(host.querySelector("[data-tour-effort=medium]"));
    /* The press opens the draft; the draft's own Create is the paid action. */
    expect(host.querySelector("[data-tour-create]")?.textContent).toBe("Open the orchestrator draft");
    await click(host.querySelector("[data-tour-create]"));

    expect(requests).toEqual([{ project: "repo-beta", launch: { engine: "claude", model: "opus", effort: "medium" } }]);
    expect(readSeatDraftField("repo-beta", "engine")).toBe("claude");
    expect(readSeatDraftField("repo-beta", "model")).toBe("opus");
    expect(readSeatDraftField("repo-beta", "effort")).toBe("medium");
    expect(created).toEqual(["closed"]);
    expect(harness.calls.filter((call) => call.method !== "GET")).toEqual([]);
  } finally {
    stop();
  }
});

test("a project that already holds a seat offers Open it in place of Create", async () => {
  harness.setRoute((url) => url.includes("/api/orchestrator/seat") ? jsonResponse(url.includes("repo-beta") ? seated("repo-beta") : { seat: null, exists: true }) : undefined);
  const requests: unknown[] = [];
  const stop = onOrchestratorDraftRequest((request) => requests.push(request));
  try {
    const host = await mount();
    expect(host.querySelector("[data-tour-create]")).toBeNull();
    expect(host.textContent).toContain("beta-app already has an orchestrator.");
    await click(host.querySelector("[data-tour-open-seat]"));
    expect(requests).toEqual([{ project: "repo-beta", launch: null }]);
  } finally {
    stop();
  }
});

test("with no projects the band says where to start, and without Claude it says why Create waits", async () => {
  harness.setRoute(() => undefined);
  let host = await mount({ projects: [], initialProject: null });
  expect(host.textContent).toContain("No projects yet. Open a folder with a repository first");
  expect(host.querySelector("[data-tour-create]")).toBeNull();
  await act(async () => mounted!.root.unmount());
  mounted!.host.remove();
  mounted = null;

  harness.setRoute((url) => url.includes("/api/orchestrator/seat") ? jsonResponse({ seat: null, exists: true }) : undefined);
  host = await mount({ claudeConnected: false });
  expect(host.textContent).toContain("The orchestrator runs on Claude, which is not connected (step 1).");
  expect(host.querySelector<HTMLButtonElement>("[data-tour-create]")?.disabled).toBe(true);
});

test("each card body stays short enough for one screen, in English and in Ukrainian", async () => {
  const { en } = await import("@/lib/i18n/en");
  const { uk } = await import("@/lib/i18n/uk");
  /* Design §2.4 bounds a body at four lines of a narrow column; 150
     characters is what the Ukrainian 1280 layout holds above the links. */
  for (const dict of [en, uk]) {
    for (const id of ["1", "2", "3", "4", "5"] as const) {
      const text = String(dict[`onboarding.tour.card${id}.body` as keyof typeof en]).replace("{check}", "5").replace("{needsYou}", "Потрібні ви");
      expect({ id, length: text.length <= 150 }).toEqual({ id, length: true });
    }
  }
});
