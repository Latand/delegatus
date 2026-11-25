import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom, jsonResponse, settle } from "@/test-helpers/onboardingDom";

/*
 * Antigravity in the sidebar footer, the account settings this engine had no
 * entry in: the row shows once `agy` is installed (or its sign-in recorded),
 * and opens the same sign-in body the Engines step shows.
 */

const dom = installOnboardingDom();
installActEnv();
const { createRoot } = await import("react-dom/client");
const { AntigravityFooterRow } = await import("./AntigravityFooterRow");

type Section = { cli: "found" | "missing"; auth: "signed_in" | "signed_out" | "unknown"; plan: string | null };
let recorded: Section = { cli: "found", auth: "signed_out", plan: null };
const body = (state: Section) => ({ cli: state.cli, active: "default", accounts: [{ id: "default", label: "Default", kind: "legacy", auth: state.auth, plan: state.plan, checkedAt: null, authPresent: state.auth === "signed_in" }] });
dom.setRoute((url, init) => {
  if (!url.includes("/api/accounts/antigravity")) return undefined;
  if (init?.method === "POST") {
    recorded = { cli: "found", auth: "signed_in", plan: "Google AI Pro" };
    return jsonResponse({ ...body(recorded), probe: { inconclusive: false } });
  }
  return jsonResponse(body(recorded));
});

let mounted: { root: Root; host: HTMLDivElement } | null = null;
afterEach(async () => {
  if (mounted) {
    await act(async () => mounted!.root.unmount());
    mounted.host.remove();
    mounted = null;
  }
  recorded = { cli: "found", auth: "signed_out", plan: null };
  dom.calls.length = 0;
});

async function mount(): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(<AntigravityFooterRow limits={null} limitsAccountId={null} now={1_800_000_000} density="line" />));
  await act(async () => { await settle(); });
  return host;
}

test("an installed agy that is signed out shows a row, and the row opens Check sign-in", async () => {
  const host = await mount();
  const row = host.querySelector("[data-engine-limits=antigravity]")!;
  expect(row.querySelector("[data-antigravity-state]")?.textContent).toBe("Signed out");
  expect(row.querySelector("[data-antigravity-panel]")).toBeNull();
  await act(async () => { row.querySelector<HTMLButtonElement>("[data-meter-line]")!.click(); await settle(); });
  const panel = row.querySelector("[data-antigravity-panel]")!;
  expect(panel.querySelector("[data-antigravity-command]")?.textContent).toBe("agy");
  await act(async () => { panel.querySelector<HTMLButtonElement>("[data-antigravity-check]")!.click(); await settle(); });
  expect(dom.calls.filter((call) => call.method === "POST")).toHaveLength(1);
  expect(panel.querySelector("[data-onboarding-engine-header]")?.textContent).toBe("Connected · Google AI Pro");
  expect(row.querySelector("[data-antigravity-state]")?.textContent).toBe("Connected · Google AI Pro");
});

test("a signed-in agy reads Connected in a row that opens nothing, and the row carries the engine mark every other row has", async () => {
  recorded = { cli: "found", auth: "signed_in", plan: "Google AI Pro" };
  const host = await mount();
  const row = host.querySelector("[data-engine-limits=antigravity]")!;
  expect(row.querySelector("[data-antigravity-state]")?.textContent).toBe("Connected · Google AI Pro");
  expect(row.querySelector("button")).toBeNull();
  expect(row.querySelector("[data-engine-mark=antigravity]")?.getAttribute("aria-label")).toBe("Antigravity");
  await act(async () => { row.querySelector<HTMLElement>("[data-meter-line]")!.click(); await settle(); });
  expect(row.querySelector("[data-antigravity-panel]")).toBeNull();
});

test("the state takes one colour in the row and in its flyout", async () => {
  recorded = { cli: "missing", auth: "unknown", plan: null };
  const host = await mount();
  const row = host.querySelector("[data-engine-limits=antigravity]")!;
  const rowTone = row.querySelector("[data-antigravity-state]")!.className.match(/text-(danger|warning|success|muted)/)![0];
  await act(async () => { row.querySelector<HTMLButtonElement>("[data-meter-line]")!.click(); await settle(); });
  expect(row.querySelector("[data-antigravity-panel] [data-onboarding-engine-header]")!.className).toContain(rowTone);
});

test("a check made elsewhere (the setup guide) updates the row without a reload", async () => {
  const host = await mount();
  const row = host.querySelector("[data-engine-limits=antigravity]")!;
  expect(row.querySelector("[data-antigravity-state]")?.textContent).toBe("Signed out");
  recorded = { cli: "found", auth: "signed_in", plan: "Google AI Ultra" };
  await act(async () => { window.dispatchEvent(new Event("llv:antigravity-auth")); await settle(); });
  expect(row.querySelector("[data-antigravity-state]")?.textContent).toBe("Connected · Google AI Ultra");
});

test("a machine that never had agy shows Not installed, and the flyout carries the install command", async () => {
  recorded = { cli: "missing", auth: "unknown", plan: null };
  const host = await mount();
  const row = host.querySelector("[data-engine-limits=antigravity]")!;
  expect(row).not.toBeNull();
  expect(row.querySelector("[data-antigravity-state]")?.textContent).toBe("Not installed");
  await act(async () => { row.querySelector<HTMLButtonElement>("[data-meter-line]")!.click(); await settle(); });
  expect(row.querySelector("[data-antigravity-panel] [data-onboarding-engine-header]")?.textContent).toBe("Not installed");
  expect(row.querySelector("[data-antigravity-panel] code")?.textContent).toBe("curl -fsSL https://antigravity.google/cli/install.sh | bash");
});

test("a server that has not answered about agy shows no row", async () => {
  dom.setRoute((url) => (url.includes("/api/accounts/antigravity") ? jsonResponse({}, 500) : undefined));
  const host = await mount();
  expect(host.querySelector("[data-engine-limits=antigravity]")).toBeNull();
  dom.setRoute((url, init) => {
    if (!url.includes("/api/accounts/antigravity")) return undefined;
    if (init?.method === "POST") {
      recorded = { cli: "found", auth: "signed_in", plan: "Google AI Pro" };
      return jsonResponse({ ...body(recorded), probe: { inconclusive: false } });
    }
    return jsonResponse(body(recorded));
  });
});

test("a missing agy with a recorded sign-in still shows the row, with how to install it", async () => {
  recorded = { cli: "missing", auth: "signed_in", plan: "Google AI Pro" };
  const host = await mount();
  const row = host.querySelector("[data-engine-limits=antigravity]")!;
  await act(async () => { row.querySelector<HTMLButtonElement>("[data-meter-line]")!.click(); await settle(); });
  expect(row.querySelector("[data-antigravity-panel] code")?.textContent).toBe("curl -fsSL https://antigravity.google/cli/install.sh | bash");
});

test("Escape closes the flyout opened by a click while focus is on the row button, and keeps focus there", async () => {
  const host = await mount();
  const row = host.querySelector("[data-engine-limits=antigravity]")!;
  const button = row.querySelector<HTMLButtonElement>("[data-meter-line]")!;
  await act(async () => { button.focus(); button.click(); await settle(); });
  expect(row.querySelector("[data-antigravity-panel]")).not.toBeNull();
  expect(document.activeElement).toBe(button);
  await act(async () => { button.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(row.querySelector("[data-antigravity-panel]")).toBeNull();
  expect(document.activeElement).toBe(button);
});

test("Escape from inside the flyout closes it and returns focus to the row button", async () => {
  const host = await mount();
  const row = host.querySelector("[data-engine-limits=antigravity]")!;
  const button = row.querySelector<HTMLButtonElement>("[data-meter-line]")!;
  await act(async () => { button.click(); await settle(); });
  const check = row.querySelector<HTMLButtonElement>("[data-antigravity-check]")!;
  await act(async () => { check.focus(); check.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  expect(row.querySelector("[data-antigravity-panel]")).toBeNull();
  expect(document.activeElement).toBe(button);
});
