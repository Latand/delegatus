import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom, jsonResponse, settle } from "@/test-helpers/onboardingDom";

/* The phone accounts screen lists Antigravity under Claude and Codex, with the same sign-in body. */

const dom = installOnboardingDom({ mobile: true });
installActEnv();
const { createRoot } = await import("react-dom/client");
const { MobileAccountsPanel } = await import("./AccountsPanel");

let agy: { cli: string; auth: string; plan: string | null } = { cli: "found", auth: "signed_out", plan: null };
dom.setRoute((url) => {
  if (url.includes("/api/accounts/antigravity")) return jsonResponse({ cli: agy.cli, active: "default", accounts: [{ id: "default", label: "Default", kind: "legacy", auth: agy.auth, plan: agy.plan, checkedAt: null, authPresent: agy.auth === "signed_in" }] });
  return undefined;
});

let mounted: { root: Root; host: HTMLDivElement } | null = null;
afterEach(async () => {
  if (mounted) {
    await act(async () => mounted!.root.unmount());
    mounted.host.remove();
    mounted = null;
  }
});

async function mount(): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(<MobileAccountsPanel />));
  await act(async () => { await settle(); });
  return host;
}

test("an installed agy that is signed out gets a section with agy and Check sign-in", async () => {
  agy = { cli: "found", auth: "signed_out", plan: null };
  const host = await mount();
  const section = host.querySelector("[data-mobile2-accounts-engine=antigravity]")!;
  expect(section.querySelector("[data-onboarding-engine-header]")?.textContent).toBe("Installed, signed out");
  expect(section.querySelector("[data-antigravity-command]")?.textContent).toBe("agy");
  expect(section.querySelector("[data-antigravity-check]")?.textContent).toBe("Check sign-in");
});

test("a signed-in agy reads connected with its tier", async () => {
  agy = { cli: "found", auth: "signed_in", plan: "Google AI Pro" };
  const host = await mount();
  expect(host.querySelector("[data-mobile2-accounts-engine=antigravity] [data-onboarding-engine-header]")?.textContent).toBe("Connected · Google AI Pro");
});

test("a machine that never had agy shows no Antigravity section", async () => {
  agy = { cli: "missing", auth: "unknown", plan: null };
  const host = await mount();
  expect(host.querySelector("[data-mobile2-accounts-engine=antigravity]")).toBeNull();
});
