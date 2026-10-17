import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";

import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom, jsonResponse, settle } from "@/test-helpers/onboardingDom";
import type { TeamView } from "@/lib/team/contract";

/* Audit B34: a member's name and colour show at once on the row, the dialog
   heading and the radios; a refusal puts the stored ones back with the reason.
   Audit F2: removing a passkey and ending a session wait (they cannot be
   taken back), so the pressed row reads pending, sends once, and a refusal
   says why; this device leaves for sign-in only after its sign-out held. */

const harness = installOnboardingDom();
installActEnv();
const { createRoot } = await import("react-dom/client");
const { MembersTab } = await import("./MembersTab");
const { SessionsTab } = await import("./SessionsTab");
const { translate } = await import("@/lib/i18n");

const member = (id: string, name: string, role: "owner" | "member") => ({
  id, name, initials: name.slice(0, 2).toUpperCase(), color: "teal" as const, role, status: "active" as const,
  telegram: null, passkeys: 1, lastSeenAt: null, lastSurface: null, online: false, createdAt: "2026-10-01T09:00:00.000Z", revokedAt: null,
});
const OWNER = member("member-owner", "Owner Fixture", "owner");
const VIEW = { mode: "team", hostName: "fixture-host", methods: { approval: true, telegram: { available: false, botUsername: null }, passkey: { available: true } }, me: { ...OWNER, telegram: null }, members: [OWNER, member("member-b", "Member B", "member")] } as unknown as TeamView;

let mounted: { root: Root; host: HTMLDivElement } | null = null;
afterEach(async () => {
  if (mounted) { await act(async () => mounted!.root.unmount()); mounted.host.remove(); mounted = null; }
  document.body.replaceChildren();
});
async function render(element: React.ReactElement): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => { root.render(element); await settle(); });
  return host;
}
const click = (element: Element | null) => act(async () => { (element as HTMLElement).click(); await settle(2); });
/** One request held per method until the test answers it. */
function hold(method: string, other: (url: string) => Response | undefined = () => undefined) {
  const pending: Array<(response: Response) => void> = [];
  harness.setRoute((url, init) => ((init?.method ?? "GET") === method
    ? new Promise<Response>((resolve) => { pending.push(resolve); })
    : other(url) ?? (url === "/api/team/invites" ? jsonResponse({ invites: [], requests: [] }) : jsonResponse({}))));
  return (response: Response) => act(async () => { pending.shift()!(response); await settle(); });
}
const sent = (method: string) => harness.calls.filter((call) => call.method === method);
const dialog = () => document.querySelector("[data-team-dialog='member']") as HTMLElement;

test("a held rename shows the new name on the row and the dialog at once, cannot be saved twice, and a refusal puts the stored name back with the reason", async () => {
  const answer = hold("PATCH", (url) => (url === "/api/team/passkeys" ? jsonResponse({ available: true, passkeys: [] }) : undefined));
  const host = await render(<MembersTab view={VIEW} />);
  await click(host.querySelector("[data-team-member-open='member-owner']"));
  const field = dialog().querySelector("[data-team-member-rename]") as HTMLInputElement;
  await act(async () => {
    const key = Object.keys(field).find((name) => name.startsWith("__reactProps$"))!;
    (field as unknown as Record<string, { onChange(event: unknown): void }>)[key]!.onChange({ target: { value: "Owner Renamed" } });
  });
  await act(async () => { (dialog().querySelector("form") as HTMLFormElement).requestSubmit(); await settle(2); });
  expect(host.querySelector("[data-team-member='member-owner'] [data-team-member-name]")!.textContent).toBe("Owner Renamed");
  expect(dialog().textContent).toContain("Owner Renamed");
  expect((dialog().querySelector("button[type='submit']") as HTMLButtonElement).disabled).toBe(true);
  expect(sent("PATCH").map((call) => call.body)).toEqual([{ name: "Owner Renamed" }]);
  await answer(jsonResponse({ error: "taken", code: "name_taken" }, 409));
  expect(host.querySelector("[data-team-member='member-owner'] [data-team-member-name]")!.textContent).toBe("Owner Fixture");
  expect((dialog().querySelector("[data-team-member-rename]") as HTMLInputElement).value).toBe("Owner Fixture");
  expect(dialog().querySelector("[role='alert']")!.textContent).toBe(translate("en", "team.error.nameTaken"));
});

test("a picked colour is checked at once and a refusal checks the stored one again with the reason", async () => {
  const answer = hold("PATCH", (url) => (url === "/api/team/passkeys" ? jsonResponse({ available: true, passkeys: [] }) : undefined));
  const host = await render(<MembersTab view={VIEW} />);
  await click(host.querySelector("[data-team-member-open='member-owner']"));
  const radio = (label: string) => dialog().querySelector(`[role='radio'][aria-label='${label}']`) as HTMLButtonElement;
  await click(radio("Coral"));
  expect(radio("Coral").getAttribute("aria-checked")).toBe("true");
  expect(radio("Teal").getAttribute("aria-checked")).toBe("false");
  await click(radio("Coral"));
  expect(sent("PATCH").map((call) => call.body)).toEqual([{ color: "coral" }]);
  await answer(jsonResponse({ error: "forbidden" }, 403));
  expect(radio("Teal").getAttribute("aria-checked")).toBe("true");
  expect(dialog().querySelector("[role='alert']")!.textContent).toBe(translate("en", "team.error.generic"));
});

test("removing a passkey reads «Removing…» and sends once, and a refusal keeps the key listed and says why", async () => {
  const answer = hold("DELETE", (url) => (url === "/api/team/passkeys" ? jsonResponse({ available: true, passkeys: [{ id: "pk-1", label: "Laptop key", rpId: "localhost", here: true, createdAt: "2026-10-01T09:00:00.000Z", lastUsedAt: null }] }) : undefined));
  const host = await render(<MembersTab view={VIEW} />);
  await click(host.querySelector("[data-team-member-open='member-owner']"));
  const remove = () => dialog().querySelector("[data-team-passkey-remove='pk-1']") as HTMLButtonElement;
  await click(remove());
  expect(remove().disabled).toBe(true);
  expect(remove().textContent).toBe("Removing…");
  await click(remove());
  expect(sent("DELETE")).toHaveLength(1);
  await answer(jsonResponse({ error: "forbidden" }, 403));
  expect(remove().disabled).toBe(false);
  expect(remove().textContent).toBe("Remove");
  expect(dialog().querySelector("[role='alert']")!.textContent).toBe(translate("en", "team.error.generic"));
});

const SESSIONS = { sessions: [
  { id: "session-here", memberId: "member-owner", surface: "desktop", browser: "chrome", method: "passkey", createdAt: "2026-10-01T09:00:00.000Z", lastSeenAt: "2026-10-16T09:00:00.000Z", online: true, current: true },
  { id: "session-phone", memberId: "member-owner", surface: "phone", browser: "safari", method: "telegram", createdAt: "2026-10-02T09:00:00.000Z", lastSeenAt: "2026-10-15T09:00:00.000Z", online: false, current: false },
] };

test("ending a session reads «Ending…», sends once, and a refusal keeps the row and says why", async () => {
  const answer = hold("DELETE", (url) => (url === "/api/team/sessions" ? jsonResponse(SESSIONS) : undefined));
  const host = await render(<SessionsTab view={VIEW} />);
  const end = () => host.querySelector("[data-team-session='other'] [data-team-session-end]") as HTMLButtonElement;
  await click(end());
  expect(end().textContent).toBe("Ending…");
  expect(end().disabled).toBe(true);
  expect((host.querySelector("[data-team-sign-out-all]") as HTMLButtonElement).disabled).toBe(true);
  await click(end());
  expect(sent("DELETE").map((call) => call.body)).toEqual([{ id: "session-phone" }]);
  await answer(jsonResponse({ error: "forbidden" }, 403));
  expect(end().textContent).toBe("End session");
  expect(host.querySelector("[data-team-sessions-error]")!.textContent).toBe(translate("en", "team.error.generic"));
});

test("a refused sign-out of this device stays on the page and says why", async () => {
  const answer = hold("POST", (url) => (url === "/api/team/sessions" ? jsonResponse(SESSIONS) : undefined));
  const host = await render(<SessionsTab view={VIEW} />);
  const before = window.location.href;
  const signOut = () => host.querySelector("[data-team-session='current'] [data-team-session-end]") as HTMLButtonElement;
  await click(signOut());
  expect(signOut().textContent).toBe("Ending…");
  await answer(jsonResponse({ error: "unavailable" }, 503));
  expect(window.location.href).toBe(before);
  expect(signOut().textContent).toBe("Sign out");
  expect(host.querySelector("[data-team-sessions-error]")!.textContent).toBe(translate("en", "team.error.generic"));
});
