import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";

import { ENGINE_MODELS } from "@/lib/agent/models";
import { mergeRoleDefinitions } from "@/lib/roles/store";
import type { RoleEngine } from "@/lib/roles/types";
import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom, jsonResponse, settle } from "@/test-helpers/onboardingDom";

import type { EngineStatus } from "./AgentMappingTable";

/*
 * The agent mapping's engine choice: three icon-only segments that fit the
 * table's 100 px engine column (the labelled ones measured 229 px and painted
 * the Antigravity mark over the model select), labelled segments in a card,
 * and a sign-in or install action on every row whose engine is not ready.
 * jsdom measures no layout; the geometry itself is asserted in the mapping case of
 * `src/components/kanban/kanbanBoard.browser.test.tsx`.
 */

const dom = installOnboardingDom();
installActEnv();
const { createRoot } = await import("react-dom/client");
const { AgentMappingTable } = await import("./AgentMappingTable");

const agyModel = ENGINE_MODELS.antigravity[0]!.id;
function catalog(builderEngine: RoleEngine) {
  const roles = mergeRoleDefinitions({}).map((role) => ({ ...role, promptPreview: role.promptScaffold, shipped: { config: role.config } }));
  return roles.map((role) => role.id === "builder" && builderEngine === "antigravity"
    ? { ...role, config: { engine: "antigravity" as const, model: agyModel, effort: "high" } }
    : role);
}
let builderEngine: RoleEngine = "claude";
dom.setRoute((url) => url.includes("/api/roles") ? jsonResponse({ schemaVersion: 2, roles: catalog(builderEngine) }) : undefined);

const ready: EngineStatus = { connected: true, account: null };
let mounted: { root: Root; host: HTMLDivElement } | null = null;
afterEach(async () => {
  if (mounted) {
    await act(async () => mounted!.root.unmount());
    mounted.host.remove();
    mounted = null;
  }
  builderEngine = "claude";
});

async function mount(statuses: { claude: EngineStatus; codex: EngineStatus; antigravity?: EngineStatus }, layout: "table" | "card" = "table", onConnect: (engine: RoleEngine) => void = () => {}): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(<AgentMappingTable statuses={statuses} layout={layout} onConnect={onConnect} />));
  await act(async () => { await settle(); });
  return host;
}

const segment = (host: HTMLElement, row: string, engine: RoleEngine) => host.querySelector<HTMLButtonElement>(`[data-mapping-row='${row}'] [data-engine-segment='${engine}']`)!;

test("the table's three engine segments carry a mark and no text, named by their label", async () => {
  const host = await mount({ claude: ready, codex: ready, antigravity: ready });
  const segments = host.querySelectorAll("[data-mapping-row='builder'] [data-engine-segment]");
  expect(Array.from(segments).map((node) => node.getAttribute("data-engine-segment"))).toEqual(["claude", "codex", "antigravity"]);
  for (const node of Array.from(segments)) {
    expect(node.textContent).toBe("");
    expect(node.querySelector("[data-engine-mark]")).not.toBeNull();
  }
  expect(Array.from(segments).map((node) => node.getAttribute("aria-label"))).toEqual(["Claude", "Codex", "Antigravity"]);
  expect(Array.from(segments).map((node) => node.getAttribute("title"))).toEqual(["Claude", "Codex", "Antigravity"]);
  /* Everything ready: no state dot anywhere. */
  expect(host.querySelector("[data-engine-state-dot]")).toBeNull();
});

test("an Antigravity that is not connected shows a state dot and a label that says so", async () => {
  const host = await mount({ claude: ready, codex: ready, antigravity: { connected: false, account: null } });
  const button = segment(host, "builder", "antigravity");
  expect(button.querySelector("[data-engine-state-dot]")).not.toBeNull();
  expect(button.getAttribute("aria-label")).toBe("Antigravity is not connected");
  expect(button.getAttribute("title")).toBe("Antigravity is not connected");
  /* A ready engine in the same row carries none. */
  expect(segment(host, "builder", "claude").querySelector("[data-engine-state-dot]")).toBeNull();
});

test("missing and signed-out engines carry one and the same mark, so colour alone never tells them apart", async () => {
  const host = await mount({ claude: ready, codex: { connected: false, missing: true, account: null }, antigravity: { connected: false, account: null } });
  const missing = segment(host, "builder", "codex").querySelector("[data-engine-state-dot]")!;
  const signedOut = segment(host, "builder", "antigravity").querySelector("[data-engine-state-dot]")!;
  expect(missing.className).toBe(signedOut.className);
  /* The words that tell them apart ride on the labels. */
  expect(segment(host, "builder", "codex").getAttribute("aria-label")).toBe("Codex is not installed");
  expect(segment(host, "builder", "antigravity").getAttribute("aria-label")).toBe("Antigravity is not connected");
});

test("a missing engine reads not installed on its card segment too", async () => {
  const host = await mount({ claude: ready, codex: { connected: false, missing: true, account: null }, antigravity: ready }, "card");
  const codex = segment(host, "builder", "codex");
  expect(codex.getAttribute("aria-label")).toBe("Codex is not installed");
  expect(codex.querySelector("[data-engine-state-dot]")).not.toBeNull();
});

test("a missing engine reads not installed on its segment", async () => {
  const host = await mount({ claude: ready, codex: { connected: false, missing: true, account: null }, antigravity: ready });
  expect(segment(host, "builder", "codex").getAttribute("aria-label")).toBe("Codex is not installed");
});

test("a row on Antigravity signed out offers Sign in, which asks for that engine", async () => {
  builderEngine = "antigravity";
  const asked: RoleEngine[] = [];
  const host = await mount({ claude: ready, codex: ready, antigravity: { connected: false, account: null } }, "table", (engine) => asked.push(engine));
  const row = host.querySelector("[data-mapping-row='builder']")!;
  expect(row.getAttribute("data-mapping-blocked")).toBe("");
  const action = row.querySelector<HTMLButtonElement>("[data-mapping-connect=antigravity]")!;
  expect(action.textContent).toBe("Sign in");
  await act(async () => { action.click(); });
  expect(asked).toEqual(["antigravity"]);
});

test("a row on a missing Antigravity offers How to install", async () => {
  builderEngine = "antigravity";
  const host = await mount({ claude: ready, codex: ready, antigravity: { connected: false, missing: true, account: null } });
  const action = host.querySelector("[data-mapping-row='builder'] [data-mapping-connect=antigravity]")!;
  expect(action.textContent).toBe("How to install");
  expect(host.querySelector("[data-mapping-row='builder']")!.textContent).toContain("Antigravity is not installed");
});

test("a connected engine's rows offer no sign-in action", async () => {
  builderEngine = "antigravity";
  const host = await mount({ claude: ready, codex: ready, antigravity: { connected: true, account: null } });
  expect(host.querySelector("[data-mapping-connect]")).toBeNull();
});

test("Claude and Codex rows get the same action when they are the engine that is out", async () => {
  const asked: RoleEngine[] = [];
  const host = await mount({ claude: { connected: false, account: null }, codex: { connected: false, missing: true, account: null }, antigravity: ready }, "table", (engine) => asked.push(engine));
  /* Shipped rows sit on both engines; the first row on Claude carries Claude's action. */
  const claudeAction = host.querySelector<HTMLButtonElement>("[data-mapping-connect=claude]");
  expect(claudeAction?.textContent).toBe("Sign in");
  const codexRow = Array.from(host.querySelectorAll("[data-mapping-row]")).find((row) => row.querySelector("[data-mapping-connect=codex]"));
  expect(codexRow?.querySelector("[data-mapping-connect=codex]")?.textContent).toBe("How to install");
  await act(async () => { claudeAction!.click(); });
  expect(asked).toEqual(["claude"]);
});

test("the phone card keeps the engine names on its segments and the same action under them", async () => {
  builderEngine = "antigravity";
  const asked: RoleEngine[] = [];
  const host = await mount({ claude: ready, codex: ready, antigravity: { connected: false, account: null } }, "card", (engine) => asked.push(engine));
  const labels = Array.from(host.querySelectorAll("[data-mapping-row='builder'] [data-engine-segment]")).map((node) => node.textContent);
  expect(labels).toEqual(["Claude", "Codex", "Antigravity"]);
  /* A touch screen never shows a title: the state is a visible mark and part of the accessible name. */
  const unready = segment(host, "builder", "antigravity");
  expect(unready.querySelector("[data-engine-state-dot]")).not.toBeNull();
  expect(unready.getAttribute("aria-label")).toBe("Antigravity is not connected");
  expect(segment(host, "builder", "claude").querySelector("[data-engine-state-dot]")).toBeNull();
  expect(segment(host, "builder", "claude").getAttribute("aria-label")).toBe("Claude");
  const action = host.querySelector<HTMLButtonElement>("[data-mapping-row='builder'] [data-mapping-connect=antigravity]")!;
  await act(async () => { action.click(); });
  expect(asked).toEqual(["antigravity"]);
});
