import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom, jsonResponse, settle } from "@/test-helpers/onboardingDom";

/*
 * Antigravity's sign-in card on the real hook: the recorded state it reads
 * (`GET /api/accounts/antigravity`), the one automatic check when `agy` is
 * installed and nothing has recorded its sign-in, and the "Check sign-in"
 * button's POST.
 */

const dom = installOnboardingDom();
installActEnv();
const { createRoot } = await import("react-dom/client");
const { AntigravityCard, useAntigravityAccount } = await import("./AntigravityCard");

type Recorded = { cli: "found" | "missing"; auth: "signed_in" | "signed_out" | "unknown"; plan: string | null };
let recorded: Recorded = { cli: "found", auth: "unknown", plan: null };
/* What a probe records, or null for a check that reaches no answer. */
let probeAnswer: Recorded | null = null;

const section = (state: Recorded) => ({ cli: state.cli, active: "default", accounts: [{ id: "default", label: "Default", kind: "legacy", auth: state.auth, plan: state.plan, checkedAt: null, authPresent: state.auth === "signed_in" }] });
dom.setRoute((url, init) => {
  if (!url.includes("/api/accounts/antigravity")) return undefined;
  if (init?.method === "POST") {
    if (probeAnswer === null) return jsonResponse({ ...section(recorded), probe: { inconclusive: true } });
    recorded = probeAnswer;
    return jsonResponse({ ...section(recorded), probe: { inconclusive: false } });
  }
  return jsonResponse(section(recorded));
});

function Harness({ autoProbe }: { autoProbe: boolean }) {
  const agy = useAntigravityAccount({ autoProbe });
  return <AntigravityCard agy={agy} cli={agy.cli} recheck={null} />;
}

let mounted: { root: Root; host: HTMLDivElement } | null = null;
afterEach(async () => {
  if (mounted) {
    await act(async () => mounted!.root.unmount());
    mounted.host.remove();
    mounted = null;
  }
  recorded = { cli: "found", auth: "unknown", plan: null };
  probeAnswer = null;
  dom.calls.length = 0;
});

async function mount(autoProbe: boolean): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(<Harness autoProbe={autoProbe} />));
  await act(async () => { await settle(); });
  return host;
}

const posts = () => dom.calls.filter((call) => call.method === "POST" && call.url.includes("/api/accounts/antigravity"));
const card = (host: HTMLElement) => host.querySelector("[data-onboarding-engine=antigravity]")!;

test("signed out: the card names the state, shows agy with a copy control, and Check sign-in posts the probe", async () => {
  recorded = { cli: "found", auth: "signed_out", plan: null };
  const host = await mount(false);
  expect(card(host).getAttribute("data-engine-state")).toBe("signed-out");
  expect(card(host).querySelector("[data-onboarding-engine-header]")?.textContent).toBe("Installed, signed out");
  expect(card(host).querySelector("[data-antigravity-command]")?.textContent).toBe("agy");
  expect(card(host).querySelector("button[aria-label='Copy command']")).not.toBeNull();
  /* Reading the record starts nothing. */
  expect(posts()).toHaveLength(0);

  probeAnswer = { cli: "found", auth: "signed_in", plan: "Google AI Pro" };
  await act(async () => { card(host).querySelector<HTMLButtonElement>("[data-antigravity-check]")!.click(); await settle(); });
  expect(posts()).toHaveLength(1);
  expect(posts()[0]!.body).toEqual({ action: "probe" });
  expect(card(host).getAttribute("data-engine-state")).toBe("connected");
  expect(card(host).querySelector("[data-onboarding-engine-header]")?.textContent).toBe("Connected · Google AI Pro");
});

test("unknown with agy installed: one automatic check, and a signed-in answer reads connected", async () => {
  probeAnswer = { cli: "found", auth: "signed_in", plan: "Google AI Ultra" };
  const host = await mount(true);
  expect(posts()).toHaveLength(1);
  expect(card(host).getAttribute("data-engine-state")).toBe("connected");
  expect(card(host).querySelector("[data-onboarding-engine-header]")?.textContent).toBe("Connected · Google AI Ultra");
});

test("without autoProbe nothing is started on mount", async () => {
  const host = await mount(false);
  expect(posts()).toHaveLength(0);
  expect(card(host).getAttribute("data-engine-state")).toBe("unknown");
  expect(card(host).querySelector("[data-onboarding-engine-header]")?.textContent).toBe("Could not check sign-in.");
});

test("a check that reaches no answer says so and keeps the recorded state", async () => {
  recorded = { cli: "found", auth: "signed_out", plan: null };
  probeAnswer = null;
  const host = await mount(false);
  await act(async () => { card(host).querySelector<HTMLButtonElement>("[data-antigravity-check]")!.click(); await settle(); });
  expect(posts()).toHaveLength(1);
  expect(card(host).getAttribute("data-engine-state")).toBe("signed-out");
  expect(card(host).querySelector("[data-antigravity-inconclusive]")?.textContent).toBe("Could not reach an answer from agy. Try again.");
});

test("a failed automatic check is not repeated on every render", async () => {
  probeAnswer = null;
  await mount(true);
  expect(posts()).toHaveLength(1);
});

test("agy missing: Not installed with the official install command and no sign-in", async () => {
  recorded = { cli: "missing", auth: "unknown", plan: null };
  const host = await mount(true);
  expect(card(host).getAttribute("data-engine-state")).toBe("missing");
  expect(card(host).querySelector("[data-onboarding-engine-header]")?.textContent).toBe("Not installed");
  expect(card(host).querySelector("code")?.textContent).toBe("curl -fsSL https://antigravity.google/cli/install.sh | bash");
  expect(card(host).querySelector("[data-antigravity-signin]")).toBeNull();
  /* A missing command is never probed. */
  expect(posts()).toHaveLength(0);
});
