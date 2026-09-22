import { afterEach, expect, test } from "bun:test";
import { act, createRef } from "react";
import type { Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom, jsonResponse, settle } from "@/test-helpers/onboardingDom";

/*
 * The phone tour is a pager Continue turns. On its last page Continue no
 * longer turns a page and the band's own button is the next press, so the
 * guide is told the pager reached its end and Continue can give up its fill.
 */

const harness = installOnboardingDom({ mobile: true });
installActEnv();
const { createRoot } = await import("react-dom/client");
const { TourStep } = await import("./TourStep");
type TourHandle = import("./TourStep").TourHandle;

let mounted: { root: Root; host: HTMLDivElement } | null = null;
afterEach(async () => {
  if (mounted) {
    await act(async () => mounted!.root.unmount());
    mounted.host.remove();
    mounted = null;
  }
});

test("the pager reports its last page, and only its last page", async () => {
  harness.setRoute((url) => url.includes("/api/orchestrator/seat") ? jsonResponse({ seat: null, exists: true }) : undefined);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  const handle = createRef<TourHandle>();
  const ends: boolean[] = [];
  await act(async () => root.render(
    <TourStep handle={handle} projects={[{ project: "repo-alpha", name: "alpha" }]} initialProject={null} claudeConnected checkMinutes={5} onCreated={() => {}} onAtEnd={(atEnd) => ends.push(atEnd)} />,
  ));
  await act(async () => settle());
  expect(host.querySelector("[data-onboarding-tour=phone]")).not.toBeNull();
  expect(ends.at(-1)).toBe(false);
  for (let page = 1; page < 5; page += 1) {
    let turned = false;
    await act(async () => { turned = handle.current!.advance(); });
    expect(turned).toBe(true);
    expect(ends.at(-1)).toBe(page === 4);
  }
  let again = true;
  await act(async () => { again = handle.current!.advance(); });
  expect(again).toBe(false);
  expect(ends.at(-1)).toBe(true);
});
