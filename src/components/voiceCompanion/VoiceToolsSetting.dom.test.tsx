import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom, jsonResponse, settle, typeInto } from "@/test-helpers/onboardingDom";
import type { VoiceToolsView } from "@/lib/voiceTools/contracts";

/*
 * The Tools section of the voice settings (docs/design/voice-extensible-tools.md
 * §4.8 item 1) over a stub of `/api/voice-tools` that answers as the route does:
 * the view on a read and after each write, a fixed code on a refusal. What is
 * read: what a proposal will run, by name only; that a secret leaves once and is
 * never drawn again; that each press carries the digest it was shown; that the
 * operator's own switch keeps an approved server approved; and that a refusal
 * reads beside the control pressed and puts back what the press changed.
 */

const harness = installOnboardingDom();
installActEnv();
const { createRoot } = await import("react-dom/client");
const { VoiceToolsSetting } = await import("./VoiceToolsSetting");
const { translate } = await import("@/lib/i18n/core");
const { resetLocaleForTests, setLocale } = await import("@/lib/i18n");

const SECRET = ["fixture", "spotify", "client", "7"].join("-");
const AT = "2026-10-21T09:00:00.000Z";
const digestOf = (seed: number) => `sha256:${seed.toString(16).padStart(64, "0")}`;
type Server = VoiceToolsView["servers"][string];
const catalog = { digest: digestOf(900), fetchedAt: AT, tools: [
  { name: "search", description: "Search Spotify.", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "play", description: "Start playback.", inputSchema: { type: "object" } },
] };
function spotify(over: Partial<Server> = {}): Server {
  return {
    title: "Spotify", capability: "Music: play and search.", entryFile: null, private: false, askBeforeActing: false, callTimeoutMs: 15_000,
    transport: { type: "stdio", command: "uv", args: ["tool", "run", "spotify-mcp-example"], cwd: null, envNames: ["SPOTIFY_CLIENT_ID", "SPOTIFY_REDIRECT_URI"], envValues: { SPOTIFY_REDIRECT_URI: "http://127.0.0.1:8888/callback" } },
    generation: 3, owner: "installation", audience: ["voice"], state: "pending", proposedBy: { kind: "conversation", conversationId: "conv_a", at: AT },
    approval: null, tools: {}, catalog: null, lastDryRun: null, digest: digestOf(1), missingSecrets: ["spotify-client-id"], secretRefs: ["spotify-client-id"], secretDestinations: { "spotify-client-id": ["stdio:spotify"] }, ...over,
  };
}
type Answer = { status: number; body: unknown };
/** The route over one record. `refuse` answers the next write of an action with a code. */
function routes(servers: Record<string, Server>) {
  const record = { revision: 1, servers: structuredClone(servers) };
  const refuse: Record<string, string> = {};
  const view = (): VoiceToolsView => ({ version: 1, revision: record.revision, servers: structuredClone(record.servers) });
  harness.setRoute((url, init) => {
    if (new URL(url, "http://127.0.0.1:8898").pathname !== "/api/voice-tools") return undefined;
    if (!init?.method || init.method === "GET") return jsonResponse(view());
    const body = JSON.parse(String(init.body)) as { action: string; name?: string; digest?: string; tools?: Server["tools"]; askBeforeActing?: boolean; reapprove?: true; secrets?: Record<string, { value?: string; destinations: string[] }> };
    const answer = ((): Answer => {
      if (refuse[body.action]) { const code = refuse[body.action]; delete refuse[body.action]; return { status: 409, body: { code } }; }
      record.revision += 1;
      if (body.action === "secrets") {
        for (const server of Object.values(record.servers)) {
          server.missingSecrets = server.missingSecrets.filter(ref => !Object.hasOwn(body.secrets!, ref));
          for (const ref of server.secretRefs) if (Object.hasOwn(body.secrets!, ref)) server.secretDestinations[ref] = body.secrets![ref].destinations;
        }
        return { status: 200, body: view() };
      }
      const server = record.servers[body.name!];
      if (!server) return { status: 409, body: { code: "SERVER_NOT_FOUND" } };
      if (server.digest !== body.digest) return { status: 409, body: { code: "STALE_APPROVAL" } };
      const next = digestOf(record.revision * 10);
      if (body.action === "configure") {
        if (body.reapprove && server.state !== "enabled") return { status: 409, body: { code: "STALE_APPROVAL" } };
        if (body.tools) server.tools = body.tools;
        if (body.askBeforeActing !== undefined) server.askBeforeActing = body.askBeforeActing;
        server.digest = next;
        /* Re-approval commits with the change, as the store's one mutation does. */
        if (body.reapprove) { server.state = "enabled"; server.approval = { by: "operator", at: AT, digest: next }; }
        else { server.state = "pending"; server.approval = null; }
      } else if (body.action === "approve") {
        if (server.lastDryRun?.code !== "OK") return { status: 409, body: { code: "DRY_RUN_REQUIRED" } };
        server.state = "enabled"; server.approval = { by: "operator", at: AT, digest: server.digest };
      } else if (body.action === "dry-run") {
        server.lastDryRun = { code: "OK", at: AT, digest: digestOf(500) }; server.catalog = catalog;
        server.tools = { search: { enabled: false, acts: false }, play: { enabled: false, acts: true } }; server.digest = next;
      } else if (body.action === "remove") delete record.servers[body.name!];
      else { server.state = body.action === "reject" ? "rejected" : "disabled"; server.digest = next; }
      return { status: 200, body: view() };
    })();
    return jsonResponse(answer.body, answer.status);
  });
  return { record, refuse };
}
const writes = () => harness.calls.filter(call => call.method === "POST").map(call => call.body);

let mounted: { root: Root; host: HTMLDivElement } | null = null;
afterEach(async () => {
  if (mounted) { const { root, host } = mounted; await act(async () => root.unmount()); host.remove(); mounted = null; }
});
async function mount(): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(<VoiceToolsSetting />));
  await act(async () => settle());
  return host;
}
const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await act(async () => settle());
};
const button = (host: Element, action: string) => host.querySelector<HTMLButtonElement>(`[data-voice-tool-action='${action}']`);

test("no servers reads as such, and a failed read offers a retry that recovers", async () => {
  let fail = true;
  harness.setRoute(url => url.startsWith("/api/voice-tools") ? (fail ? jsonResponse({ code: "REGISTRY_UNAVAILABLE" }, 409) : jsonResponse({ version: 1, revision: 0, servers: {} })) : undefined);
  const host = await mount();
  expect(host.querySelector("[data-voice-tools-status]")?.textContent).toBe(translate("en", "voiceCompanion.tools.error"));
  fail = false;
  await click([...host.querySelectorAll("button")].find(node => node.textContent === translate("en", "voiceCompanion.tools.retry")));
  expect(host.querySelector("[data-voice-tools-status]")?.textContent).toBe(translate("en", "voiceCompanion.tools.empty"));
  expect(host.querySelector("[data-voice-tool-server]")).toBeNull();
});

test("a pending proposal shows what will run by name, takes its secret once and never draws it again", async () => {
  const { record } = routes({ spotify: spotify({ transport: { type: "stdio", command: "bun", args: ["run", "/srv/tools/notes server.ts"], cwd: "/srv/tools", envNames: ["NOTES_FORMAT", "NOTES_TOKEN"], envValues: { NOTES_FORMAT: "markdown" } },
    entryFile: { path: "/srv/tools/notes server.ts", sha256: "ab".repeat(32) } }) });
  const host = await mount();
  const row = host.querySelector<HTMLElement>("[data-voice-tool-server='spotify']")!;
  expect(row.dataset.state).toBe("pending");
  expect(row.querySelector("[data-voice-tool-state]")?.textContent).toBe("Waiting for approval");
  expect(row.querySelector("[data-voice-tool-runs] code")?.textContent).toBe("bun run '/srv/tools/notes server.ts'");
  expect(row.querySelector("[data-voice-tool-env]")?.textContent).toBe("Environment: NOTES_FORMAT=markdown, NOTES_TOKEN (secret)");
  expect(row.querySelector("[data-voice-tool-entry]")?.textContent).toBe(`Pinned file: /srv/tools/notes server.ts · SHA-256 ${"ab".repeat(6)}…`);
  expect(row.querySelector("[data-voice-tool-dry-run]")?.textContent).toBe("Dry run: not run yet.");
  /* A needed secret holds the dry run and the approval back. */
  expect(row.querySelector("[data-voice-tool-reference='spotify-client-id']")?.hasAttribute("data-missing")).toBe(true);
  expect([button(row, "dry-run")!.disabled, button(row, "approve")!.disabled]).toEqual([true, true]);

  const input = row.querySelector<HTMLInputElement>("[data-voice-tool-reference] input")!;
  expect(input.type).toBe("password");
  await act(async () => typeInto(input, SECRET));
  await act(async () => { row.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
  await act(async () => settle());
  expect(writes()).toEqual([{ action: "secrets", secrets: { "spotify-client-id": { value: SECRET, destinations: ["stdio:spotify"] } } }]);
  expect(record.servers.spotify.missingSecrets).toEqual([]);
  expect(host.querySelector<HTMLInputElement>("[data-voice-tool-reference] input")!.value).toBe("");
  expect(host.innerHTML).not.toContain(SECRET);
  expect(host.querySelector("[data-voice-tool-reference='spotify-client-id']")?.textContent).toContain("saved");

  /* The dry run carries the digest shown, and its tools arrive unchosen. */
  await click(button(host, "dry-run"));
  expect(writes().at(-1)).toEqual({ action: "dry-run", name: "spotify", digest: digestOf(1) });
  expect(host.querySelector("[data-voice-tool-dry-run]")?.textContent).toMatch(/^Dry run passed .+: 2 tools found\.$/u);
  expect([...host.querySelectorAll<HTMLInputElement>("[data-voice-tool] input")].map(box => box.checked)).toEqual([false, false]);
  expect([...host.querySelectorAll("[data-voice-tool]")].map(node => node.textContent)).toEqual(["search · reads onlySearch Spotify.", "play · actsStart playback."]);
});

test("choosing a tool and approving each carry the current digest; the server reads approved", async () => {
  routes({ spotify: spotify({ missingSecrets: [], catalog, lastDryRun: { code: "OK", at: AT, digest: digestOf(500) }, tools: { search: { enabled: false, acts: false }, play: { enabled: false, acts: true } } }) });
  const host = await mount();
  await click(host.querySelector("[data-voice-tool='play'] input"));
  expect(writes()).toEqual([{ action: "configure", name: "spotify", digest: digestOf(1), tools: { search: { enabled: false, acts: false }, play: { enabled: true, acts: true } } }]);
  const moved = host.querySelector<HTMLElement>("[data-voice-tool-server]")!;
  await click(button(moved, "approve"));
  expect(writes().at(-1)).toEqual({ action: "approve", name: "spotify", digest: digestOf(20) });
  expect(host.querySelector("[data-voice-tool-state]")?.textContent).toBe("Approved");
  expect(button(host, "approve")).toBeNull();
  expect([button(host, "disable")?.textContent, button(host, "remove")?.textContent]).toEqual(["Turn off", "Remove"]);
});

test("«ask before acting» on an approved server stays approved: one write changes it and approves the moved digest", async () => {
  routes({ spotify: spotify({ state: "enabled", missingSecrets: [], catalog, lastDryRun: { code: "OK", at: AT, digest: digestOf(500) }, approval: { by: "operator", at: AT, digest: digestOf(1) },
    tools: { search: { enabled: true, acts: false }, play: { enabled: true, acts: true } } }) });
  const host = await mount();
  const ask = host.querySelector<HTMLInputElement>("[data-voice-tool-ask]")!;
  expect(ask.checked).toBe(false);
  await click(ask);
  expect(writes()).toEqual([{ action: "configure", name: "spotify", digest: digestOf(1), askBeforeActing: true, reapprove: true }]);
  expect(host.querySelector<HTMLInputElement>("[data-voice-tool-ask]")!.checked).toBe(true);
  expect(host.querySelector("[data-voice-tool-state]")?.textContent).toBe("Approved");
});

test("a refused switch flips back with its reason beside it; a refused re-approval changes nothing and the row stays approved", async () => {
  const { refuse, record } = routes({ spotify: spotify({ state: "enabled", missingSecrets: [], catalog, lastDryRun: { code: "OK", at: AT, digest: digestOf(500) }, approval: { by: "operator", at: AT, digest: digestOf(1) } }) });
  const host = await mount();
  refuse.configure = "OPERATOR_REQUIRED";
  await click(host.querySelector("[data-voice-tool-ask]"));
  expect(host.querySelector<HTMLInputElement>("[data-voice-tool-ask]")!.checked).toBe(false);
  const reason = host.querySelector<HTMLElement>("[data-voice-tools-refused]")!;
  expect([reason.dataset.voiceToolsRefused, reason.textContent, reason.getAttribute("role")]).toEqual(["OPERATOR_REQUIRED", translate("en", "voiceCompanion.tools.refused.OPERATOR_REQUIRED"), "alert"]);
  /* Beside the switch, before the action row. */
  expect(reason.compareDocumentPosition(host.querySelector("[data-voice-tool-actions]")!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

  /* The route refuses the change and its approval together: the record and the row stay as they were. */
  refuse.configure = "SELECTION_BOUNDS";
  await click(host.querySelector("[data-voice-tool-ask]"));
  expect(writes().at(-1)).toEqual({ action: "configure", name: "spotify", digest: digestOf(1), askBeforeActing: true, reapprove: true });
  expect(host.querySelector<HTMLInputElement>("[data-voice-tool-ask]")!.checked).toBe(false);
  expect(host.querySelector("[data-voice-tool-state]")?.textContent).toBe("Approved");
  expect(host.querySelector<HTMLElement>("[data-voice-tool-server]")!.dataset.state).toBe("enabled");
  expect(host.querySelector("[data-voice-tools-refused]")?.textContent).toBe(translate("en", "voiceCompanion.tools.refused.SELECTION_BOUNDS"));
  expect([record.servers.spotify.state, record.servers.spotify.askBeforeActing, record.servers.spotify.digest]).toEqual(["enabled", false, digestOf(1)]);
  /* The same for a tool on the approved server. */
  refuse.configure = "SELECTION_BOUNDS";
  await click(host.querySelector("[data-voice-tool='play'] input"));
  expect(host.querySelector<HTMLInputElement>("[data-voice-tool='play'] input")!.checked).toBe(false);
  expect(host.querySelector("[data-voice-tool-state]")?.textContent).toBe("Approved");
  expect(host.querySelector("[data-voice-tools-refused]")?.textContent).toBe(translate("en", "voiceCompanion.tools.refused.SELECTION_BOUNDS"));
});

test("under Run dry run, the hub's limit and a refused tool list read as dry-run reasons, and the file lock as another change", async () => {
  const { refuse } = routes({ spotify: spotify({ missingSecrets: [] }) });
  const host = await mount();
  for (const [code, key] of [["BUSY", "voiceCompanion.tools.refused.dryRun.BUSY"], ["CATALOG_BOUNDS", "voiceCompanion.tools.refused.dryRun.CATALOG_BOUNDS"], ["VOICE_TOOLS_BUSY", "voiceCompanion.tools.refused.BUSY"]] as const) {
    refuse["dry-run"] = code;
    await click(button(host, "dry-run"));
    const reason = host.querySelector<HTMLElement>("[data-voice-tools-refused]")!;
    expect([reason.dataset.voiceToolsRefused, reason.textContent]).toEqual([code, translate("en", key)]);
    expect(host.querySelector("[data-voice-tool-actions]")!.compareDocumentPosition(reason) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  }
  expect(translate("uk", "voiceCompanion.tools.refused.dryRun.BUSY")).not.toBe(translate("en", "voiceCompanion.tools.refused.dryRun.BUSY"));
});

test("a failed dry run reads its reason, and a stale digest rereads the record before the next press", async () => {
  const { record } = routes({ notes: spotify({ title: "Notes", missingSecrets: [], secretRefs: [], lastDryRun: { code: "TIMEOUT", at: AT, digest: digestOf(500) } }) });
  const host = await mount();
  const line = host.querySelector<HTMLElement>("[data-voice-tool-dry-run]")!;
  expect(line.dataset.voiceToolDryRun).toBe("TIMEOUT");
  expect(line.textContent).toMatch(/^Dry run failed .+: the server did not answer within 20 seconds\.$/u);
  expect(button(host, "approve")!.disabled).toBe(true);
  expect(host.querySelector("[data-voice-tool-tools]")).toBeNull();

  record.servers.notes.digest = digestOf(77);
  await click(button(host, "reject"));
  expect(host.querySelector("[data-voice-tools-refused]")?.textContent).toBe(translate("en", "voiceCompanion.tools.refused.STALE_APPROVAL"));
  expect(harness.calls.filter(call => call.method === "GET")).toHaveLength(2);
  await click(button(host, "reject"));
  expect(writes().at(-1)).toEqual({ action: "reject", name: "notes", digest: digestOf(77) });
  expect(host.querySelector("[data-voice-tool-state]")?.textContent).toBe("Rejected");
  expect(button(host, "remove")).not.toBeNull();
});

test("an HTTP server shows its URL, a literal header's value and a secret header's name, and the Ukrainian strings cover every visible line", async () => {
  routes({ remote: spotify({ title: "Remote", transport: { type: "http", url: "https://mcp.example.test/v1", headerNames: ["Authorization", "X-Workspace"], headerValues: { "X-Workspace": "studio-a" } },
    missingSecrets: [], secretRefs: ["remote-token"] }) });
  setLocale("uk");
  try {
    const host = await mount();
    const row = host.querySelector<HTMLElement>("[data-voice-tool-server='remote']")!;
    expect(row.querySelector("[data-voice-tool-runs] code")?.textContent).toBe("https://mcp.example.test/v1");
    expect(row.querySelector("[data-voice-tool-headers]")?.textContent).toBe("Заголовки: Authorization (секрет), X-Workspace=studio-a");
    expect(row.textContent).toContain("Підключається до");
    expect(row.querySelector("[data-voice-tool-state]")?.textContent).toBe("Чекає на схвалення");
    expect(host.textContent).not.toMatch(/Waiting|Approve|Dry run|Secrets/u);
  } finally { resetLocaleForTests(); localStorage.removeItem("llv_lang"); }
});

test("beside Run dry run, a command's row says the press starts the program as your OS user, in English and Ukrainian; an address's row does not", async () => {
  const hints = { en: translate("en", "voiceCompanion.tools.dryRunHint"), uk: translate("uk", "voiceCompanion.tools.dryRunHint") };
  expect(hints.en).toBe("Run dry run starts this program as your OS user to list its tools, so press it only for what you trust.");
  expect(hints.uk).toBe("«Пробний запуск» запускає цю програму від імені вашого користувача ОС, щоб отримати список її інструментів, тож натискайте його лише для того, чому довіряєте.");
  /* The approval sentence stays in the intro beside it. */
  expect(translate("en", "voiceCompanion.tools.intro")).toContain("An approved server runs as your OS user");
  for (const locale of ["en", "uk"] as const) {
    routes({ spotify: spotify({ missingSecrets: [] }), remote: spotify({ title: "Remote", transport: { type: "http", url: "https://mcp.example.test/v1", headerNames: [], headerValues: {} }, missingSecrets: [], secretRefs: [] }) });
    if (locale === "uk") setLocale("uk");
    try {
      const host = await mount();
      const row = host.querySelector<HTMLElement>("[data-voice-tool-server='spotify']")!;
      const hint = row.querySelector<HTMLElement>("[data-voice-tool-dry-run-hint]")!;
      expect(hint.textContent).toBe(hints[locale]);
      expect(button(row, "dry-run")!.getAttribute("aria-describedby")).toBe(hint.id);
      expect(row.querySelector("[data-voice-tool-actions]")!.compareDocumentPosition(hint) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
      const remote = host.querySelector<HTMLElement>("[data-voice-tool-server='remote']")!;
      expect([remote.querySelector("[data-voice-tool-dry-run-hint]"), button(remote, "dry-run")!.hasAttribute("aria-describedby")]).toEqual([null, false]);
      /* Once approved there is no Run dry run, and no line about it. */
      await click(button(row, "dry-run"));
      await click(button(host.querySelector<HTMLElement>("[data-voice-tool-server='spotify']")!, "approve"));
      const approved = host.querySelector<HTMLElement>("[data-voice-tool-server='spotify']")!;
      expect([approved.dataset.state, approved.querySelector("[data-voice-tool-dry-run-hint]")]).toEqual(["enabled", null]);
    } finally {
      const { root, host } = mounted!; await act(async () => root.unmount()); host.remove(); mounted = null;
      resetLocaleForTests(); localStorage.removeItem("llv_lang");
    }
  }
});

test("a refused secrets save keeps what was typed beside its reason, and the next save sends it and clears the field", async () => {
  const { refuse, record } = routes({ spotify: spotify() });
  const host = await mount();
  const input = host.querySelector<HTMLInputElement>("[data-voice-tool-reference] input")!;
  await act(async () => typeInto(input, SECRET));
  const submit = async () => {
    await act(async () => { host.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
    await act(async () => settle());
  };
  refuse.secrets = "OPERATOR_REQUIRED";
  await submit();
  const reason = host.querySelector<HTMLElement>("[data-voice-tools-refused]")!;
  expect([reason.dataset.voiceToolsRefused, reason.textContent]).toEqual(["OPERATOR_REQUIRED", translate("en", "voiceCompanion.tools.refused.OPERATOR_REQUIRED")]);
  expect(record.servers.spotify.missingSecrets).toEqual(["spotify-client-id"]);
  const kept = host.querySelector<HTMLInputElement>("[data-voice-tool-reference] input")!;
  expect([kept.value, kept.disabled, host.querySelector<HTMLButtonElement>("form button[type='submit']")!.disabled]).toEqual([SECRET, false, false]);
  expect(host.innerHTML).not.toContain(SECRET);

  await submit();
  expect(writes()).toEqual([{ action: "secrets", secrets: { "spotify-client-id": { value: SECRET, destinations: ["stdio:spotify"] } } }, { action: "secrets", secrets: { "spotify-client-id": { value: SECRET, destinations: ["stdio:spotify"] } } }]);
  expect(record.servers.spotify.missingSecrets).toEqual([]);
  expect(host.querySelector<HTMLInputElement>("[data-voice-tool-reference] input")!.value).toBe("");
  expect(host.querySelector("[data-voice-tools-refused]")).toBeNull();
});


test("unbound destinations require owner input and can be renewed without resending the private value", async () => {
  routes({ spotify: spotify({ missingSecrets: [], secretDestinations: { "spotify-client-id": [] } }) });
  const host = await mount();
  const destination = host.querySelector<HTMLInputElement>("input[data-destinations]")!;
  expect(destination.value).toBe("");
  expect(host.querySelector("[data-voice-tool-destinations]")?.textContent).toContain(translate("en", "voiceCompanion.tools.destinationsSaved", { hosts: translate("en", "voiceCompanion.tools.none") }));
  await act(async () => typeInto(destination, "stdio:spotify"));
  await act(async () => { host.querySelector("form")!.dispatchEvent(new window.Event("submit", { bubbles: true, cancelable: true })); });
  await act(async () => settle());
  expect(writes()).toEqual([{ action: "secrets", secrets: { "spotify-client-id": { destinations: ["stdio:spotify"] } } }]);
});
