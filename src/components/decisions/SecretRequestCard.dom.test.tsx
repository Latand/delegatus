import { afterEach, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";

import { installActEnv } from "@/test-helpers/actEnv";
import { SECRET_BODY_TYPE, SECRET_REVISION_HEADER, type SecretRequestView } from "@/lib/secretRequests/view";

const dom = new Window({ url: "http://localhost/" });
installActEnv();
Object.assign(globalThis, {
  window: dom, document: dom.document, navigator: dom.navigator, Node: dom.Node, Element: dom.Element,
  HTMLElement: dom.HTMLElement, HTMLInputElement: dom.HTMLInputElement, Event: dom.Event, CustomEvent: dom.CustomEvent,
  localStorage: dom.localStorage, getComputedStyle: dom.getComputedStyle.bind(dom),
});
const { DecisionList } = await import("./DecisionColumn");
const { setLocale } = await import("@/lib/i18n");

const project = "project-fixture";
const request: SecretRequestView = {
  id: `sr_${"a".repeat(32)}`, project, state: "pending",
  createdAt: Date.UTC(2026, 10, 25, 19), expiresAt: Date.UTC(2026, 10, 26, 19),
  requester: { title: "Project seat", engine: "codex", role: "orchestrator" },
  purpose: "Prepare the service <a>as plain text</a>.",
  destination: { kind: "env", key: "FIXTURE", path: "/workspace/service/.env", effect: "env-add", git: "ignored" },
  destinationRevision: "a".repeat(64), format: "token", minLength: 5,
};

let root: Root | undefined;
const realFetch = globalThis.fetch;
afterEach(async () => {
  if (root) await act(async () => root?.unmount());
  root = undefined;
  dom.document.body.innerHTML = "";
  localStorage.clear();
  globalThis.fetch = realFetch;
});

async function render() {
  setLocale("en");
  const host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => root?.render(<DecisionList project={project} />));
  return host;
}

const answer = (secretRequests?: SecretRequestView[]) => Response.json({ project, decisions: [], secretRequests });
function click(element: HTMLElement | null) {
  expect(element).not.toBeNull();
  return act(async () => element!.click());
}

async function type(input: HTMLInputElement, value: string) {
  await act(async () => {
    input.value = value;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

test("uncontrolled entry validates and clears the field before the save answers", async () => {
  let release: (response: Response) => void = () => {};
  const held = new Promise<Response>(resolve => { release = resolve; });
  const canary = randomBytes(18).toString("hex");
  let posted = false;
  let requests = [request];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (!init?.method) return answer(requests);
    expect(url).toBe(`/api/secret-requests/${request.id}/value`);
    const headers = new Headers(init.headers);
    expect(headers.get(SECRET_REVISION_HEADER)).toBe(request.destinationRevision);
    expect(headers.get("content-type")).toBe(SECRET_BODY_TYPE);
    posted = new TextDecoder().decode(init.body as Uint8Array) === canary;
    return held;
  }) as typeof fetch;
  const host = await render();
  const input = host.querySelector<HTMLInputElement>("[data-secret-request] input")!;
  const save = host.querySelector<HTMLButtonElement>("[data-secret-save]")!;
  expect(input.type).toBe("password");
  expect(input.hasAttribute("value")).toBe(false);
  expect(input.hasAttribute("name")).toBe(false);
  expect(input.autocomplete).toBe("off");
  expect(input.getAttribute("autocorrect")).toBe("off");
  expect(input.getAttribute("autocapitalize")).toBe("none");
  expect(input.getAttribute("spellcheck")).toBe("false");
  expect(host.querySelectorAll("[data-secret-request] form input")).toHaveLength(1);
  expect(host.querySelectorAll("[data-secret-request] form button")).toHaveLength(2);
  expect(host.querySelector("blockquote a")).toBeNull();
  expect(host.textContent).toContain("Project seat");
  expect(host.textContent).toContain("/workspace/service/.env");
  const stored = Object.keys(localStorage);
  for (const invalid of ["four", "has space", "dollar$sign", "x".repeat(4097), "nonascii☃"]) {
    await type(input, invalid);
    expect(save.disabled).toBe(true);
  }
  await type(input, canary);
  expect(Object.keys(localStorage)).toEqual(stored);
  expect(save.disabled).toBe(false);
  await click(host.querySelector('button[aria-pressed="false"]'));
  expect(input.type).toBe("text");
  await click(save);
  expect(posted).toBe(true);
  expect(input.value).toBe("");
  expect(input.type).toBe("password");
  expect(save.disabled).toBe(true);
  expect(host.innerHTML.includes(canary)).toBe(false);
  requests = [];
  await act(async () => release(answer([])));
  expect(host.querySelector("[data-secret-request]")).toBeNull();
  expect(host.textContent).toContain("Saved to .env.");
  expect(Object.keys(localStorage)).toEqual(stored);
});

test("a refused save brings the new destination into view and decline posts no value", async () => {
  const next: SecretRequestView = { ...request, destinationRevision: "b".repeat(64),
    destination: { ...request.destination, path: "/workspace/changed/.env", effect: "env-replace" } };
  let requests = [request];
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (url.endsWith("/value")) {
      requests = [next];
      return Response.json({ code: "secret_destination_changed", secretRequests: requests }, { status: 409 });
    }
    if (url.endsWith("/decline")) {
      expect(init?.method).toBe("POST");
      expect(init?.body).toBeUndefined();
      requests = [];
    }
    return answer(requests);
  }) as typeof fetch;
  const host = await render();
  const field = () => host.querySelector<HTMLInputElement>("input")!;
  await type(field(), "test-only");
  await click(host.querySelector("[data-secret-save]"));
  expect(field().value).toBe("");
  expect(field().type).toBe("password");
  expect(host.querySelector("[role=alert]")?.textContent).toContain("The destination changed");
  expect(host.querySelector("[data-secret-destination]")?.textContent).toBe("/workspace/changed/.env");
  expect(host.textContent).toContain("Replaces FIXTURE");
  await click(host.querySelector("[data-secret-decline]"));
  expect(host.querySelector("input")).toBeNull();
  expect(host.textContent).toContain("Secret request declined.");
});

test("the member projection omits the card, including after a change of authority", async () => {
  let isOwner = true;
  globalThis.fetch = Object.assign(async () => answer(isOwner ? [request] : undefined), { preconnect: realFetch.preconnect });
  const host = await render();
  const input = host.querySelector<HTMLInputElement>("input")!;
  await type(input, "test-only");
  isOwner = false;
  const { fireTasksChanged } = await import("@/components/tasks/taskApi");
  await act(async () => fireTasksChanged());
  expect(host.querySelector("[data-secret-request]")).toBeNull();
  expect(host.textContent).not.toContain("Project seat");
  expect(host.innerHTML).not.toContain("test-only");
});
