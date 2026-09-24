import { afterEach, expect, test } from "bun:test";
import { act } from "react";
import type { Root } from "react-dom/client";

import type { AccessResponse, PhoneAccess, PhoneState } from "@/lib/access/phoneAccess";
import { installActEnv } from "@/test-helpers/actEnv";
import { installOnboardingDom, jsonResponse, settle } from "@/test-helpers/onboardingDom";

/*
 * The Phone step (#1876 slice 3, design §2.3): the state Tailscale is in, and
 * one button that turns phone access on from the running Viewer. A missing or
 * signed-out Tailscale gets one sentence and one link and nothing else; no
 * terminal command appears anywhere on the happy path.
 */

const harness = installOnboardingDom();
installActEnv();
const { createRoot } = await import("react-dom/client");
const { PhoneStep } = await import("./PhoneStep");

const DNS = "viewer-host.example-tailnet.ts.net";
const KEY = "0123456789abcdef0123456789abcdef";
const LINK = `https://${DNS}/?k=${KEY}`;

function phone(state: PhoneState, over: Partial<PhoneAccess> = {}): PhoneAccess {
  const withDns = state !== "missing" && state !== "needs-login" && state !== "no-dns";
  return { state, dnsName: withDns ? DNS : null, viewerPort: 8898, servingPort: state === "serving" || state === "exposed" ? 8898 : state === "serving-other" ? 3000 : null, persisted: state === "serving", ...over };
}
const access = (state: PhoneState, over: Partial<PhoneAccess> = {}): AccessResponse => ({ tailnetUrl: state === "serving" ? LINK : null, phone: phone(state, over), phoneError: null });

let mounted: { root: Root; host: HTMLDivElement } | null = null;
afterEach(async () => {
  if (mounted) {
    const { root, host } = mounted;
    await act(async () => root.unmount());
    host.remove();
    mounted = null;
  }
});

async function mount(props: Parameters<typeof PhoneStep>[0] = {}): Promise<HTMLDivElement> {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  mounted = { root, host };
  await act(async () => root.render(<PhoneStep {...props} />));
  await act(async () => settle());
  return host;
}

const click = async (element: Element | null | undefined) => {
  expect(element).toBeTruthy();
  await act(async () => (element as HTMLElement).click());
  await act(async () => settle());
};

const stateOf = (host: HTMLElement) => host.querySelector("[data-phone-state]")?.getAttribute("data-phone-state");
const buttons = (host: HTMLElement) => Array.from(host.querySelectorAll("button")).map((button) => button.textContent?.trim());
const links = (host: HTMLElement) => Array.from(host.querySelectorAll("a")).map((anchor) => anchor.getAttribute("href"));

const sentenceStates: Array<[PhoneState, string, string]> = [
  ["missing", "Install Tailscale on this computer and on your phone, then come back to this step.", "https://tailscale.com/download"],
  ["needs-login", "Tailscale is installed here and not signed in; sign in on this computer and this step continues by itself.", "https://tailscale.com/kb/1017/install"],
  ["no-dns", "Turn on MagicDNS and HTTPS certificates for your Tailscale network, then come back to this step.", "https://login.tailscale.com/admin/dns"],
];
for (const [state, sentence, href] of sentenceStates) {
  test(`${state}: one sentence, one link, nothing else`, async () => {
    harness.setRoute((url) => url.endsWith("/api/access") ? jsonResponse(access(state)) : undefined);
    const host = await mount();
    expect(stateOf(host)).toBe(state);
    expect(host.textContent).toContain(sentence);
    expect(links(host)).toEqual([href]);
    expect(buttons(host)).toEqual([]);
    expect(host.textContent).not.toMatch(/sudo|tailscale up|--tailscale/);
  });
}

test("a missing Tailscale is re-read by itself, and the button appears once it is ready", async () => {
  let current = access("missing");
  harness.setRoute((url) => url.endsWith("/api/access") ? jsonResponse(current) : undefined);
  const host = await mount({ pollMs: 20 });
  expect(stateOf(host)).toBe("missing");
  current = access("ready");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 60)); await settle(); });
  expect(stateOf(host)).toBe("ready");
  expect(host.querySelector("[data-phone-enable]")?.textContent).toBe("Turn on phone access");
});

test("ready: the one press turns access on, shows its wait, and comes back with the link and the QR", async () => {
  let release: (response: Response) => void = () => {};
  harness.setRoute((url, init) => {
    if (url.endsWith("/api/access/phone") && init?.method === "POST") return new Promise<Response>((resolve) => { release = resolve; });
    if (url.endsWith("/api/access")) return jsonResponse(access("ready"));
    return undefined;
  });
  const host = await mount();
  expect(host.textContent).toContain("Tailscale is signed in on this computer.");
  expect(host.textContent).toContain("remembers the choice for future starts");
  expect(host.textContent).not.toMatch(/sudo|--tailscale|bunx/);

  await click(host.querySelector("[data-phone-enable]"));
  expect(harness.calls.find((call) => call.method === "POST")?.body).toEqual({ action: "enable" });
  const busy = host.querySelector<HTMLButtonElement>("[data-phone-enable]")!;
  expect(busy.textContent).toBe("Turning on…");
  expect(busy.disabled).toBe(true);
  expect(host.textContent).toContain("This takes a few seconds.");

  await act(async () => { release(jsonResponse(access("serving"))); await settle(); });
  expect(stateOf(host)).toBe("serving");
  expect(host.textContent).toContain("Ready. Scan with your phone's camera");
  expect(host.textContent).toContain("Phone access stays on the next time you start Delegatus.");
  expect(host.textContent).toContain("Other browsers on this computer now need this link too");
  expect(host.querySelector<HTMLInputElement>("[data-phone-link]")?.value).toBe(LINK);
  expect(host.querySelector("[data-phone-copy]")).not.toBeNull();
  expect(host.querySelector("[data-phone-disable]")?.textContent).toBe("Turn off phone access");
});

test("serving-other names the other port and warns before the press", async () => {
  harness.setRoute((url) => url.endsWith("/api/access") ? jsonResponse(access("serving-other")) : undefined);
  const host = await mount();
  expect(host.textContent).toContain("Tailscale already publishes another local port (3000) at this computer's address.");
  expect(host.textContent).toContain("That other service stops being reachable at the Tailscale address.");
  expect(host.querySelector("[data-phone-enable]")?.textContent).toBe("Point it at Delegatus");
});

const failures: Array<[string, string, string]> = [
  ["OPERATOR_RIGHTS", "Access denied", "Tailscale lets only an operator publish services."],
  ["SERVE_FAILED", "error: listener already in use", "Tailscale could not publish Delegatus: error: listener already in use."],
  ["VERIFY_FAILED", "nothing published", "Tailscale reported success, and the published address does not point at Delegatus yet."],
  ["TIMEOUT", "", "Tailscale did not answer within 15 seconds."],
  ["TOKEN_WRITE_FAILED", "EACCES", "Could not save the access key: EACCES."],
  ["PERSIST_FAILED", "EROFS", "Could not remember the choice: EROFS. Nothing was turned on."],
];
for (const [code, detail, sentence] of failures) {
  test(`a failed press, ${code}, says so in a sentence with the code behind Show details`, async () => {
    harness.setRoute((url, init) => {
      if (url.endsWith("/api/access/phone") && init?.method === "POST") return jsonResponse({ ...access("ready"), error: code, code, detail }, 502);
      if (url.endsWith("/api/access")) return jsonResponse(access("ready"));
      return undefined;
    });
    const host = await mount();
    await click(host.querySelector("[data-phone-enable]"));
    const block = host.querySelector("[data-phone-failure]")!;
    expect(block.getAttribute("data-phone-failure")).toBe(code);
    expect(block.textContent).toContain(sentence);
    expect(block.querySelector("summary")?.textContent).toBe("Show details");
    expect(block.querySelector("details")?.textContent).toContain(code);
    /* The operator right is the one failure whose remedy is a command. */
    expect(Boolean(block.querySelector("code")?.textContent?.includes("sudo tailscale set --operator=$USER"))).toBe(code === "OPERATOR_RIGHTS");
    expect(host.querySelector("[data-phone-enable]")?.textContent).toBe("Try again");
  });
}

test("serving: Turn off phone access asks the server and returns to the button", async () => {
  harness.setRoute((url, init) => {
    if (url.endsWith("/api/access/phone") && init?.method === "POST") return jsonResponse(access("ready"));
    if (url.endsWith("/api/access")) return jsonResponse(access("serving"));
    return undefined;
  });
  const host = await mount();
  await click(host.querySelector("[data-phone-disable]"));
  expect(harness.calls.find((call) => call.method === "POST")?.body).toEqual({ action: "disable" });
  expect(stateOf(host)).toBe("ready");
});

test("a Tailscale state the server cannot read, and a server that does not answer, each get a sentence and Try again", async () => {
  harness.setRoute((url) => url.endsWith("/api/access") ? jsonResponse({ tailnetUrl: null, phone: null, phoneError: "STATUS_UNREADABLE" }) : undefined);
  let host = await mount();
  expect(host.textContent).toContain("Could not read Tailscale's state.");
  expect(buttons(host)).toEqual(["Try again"]);
  await act(async () => mounted!.root.unmount());
  mounted!.host.remove();
  mounted = null;

  harness.setRoute((url) => url.endsWith("/api/access") ? jsonResponse({ error: "down" }, 500) : undefined);
  host = await mount();
  expect(host.textContent).toContain("Could not read the access state.");
});

test("the step reports what it ended on, so Continue can mark it done or skipped", async () => {
  const seen: string[] = [];
  harness.setRoute((url) => url.endsWith("/api/access") ? jsonResponse(access("serving")) : undefined);
  await mount({ onState: (state) => seen.push(state) });
  expect(seen.at(-1)).toBe("serving");
});

test("exposed: a mapping this start does not gate says so, and the button re-binds it", async () => {
  harness.setRoute((url) => url.endsWith("/api/access") ? jsonResponse(access("exposed")) : undefined);
  const host = await mount();
  expect(stateOf(host)).toBe("exposed");
  expect(host.textContent).toContain("Tailscale already publishes this Delegatus install at this computer's address, and this start does not ask for the access key.");
  expect(host.querySelector("[data-phone-enable]")?.textContent).toBe("Turn on phone access");
  /* One sentence and one press: no terminal command here either. */
  expect(host.querySelector("code")).toBeNull();
});

test("a failed press that left the key on says the key stays on", async () => {
  harness.setRoute((url, init) => {
    if (url.endsWith("/api/access/phone") && init?.method === "POST") return jsonResponse({ ...access("ready"), error: "TIMEOUT", code: "TIMEOUT", detail: "", keyKept: true }, 504);
    if (url.endsWith("/api/access")) return jsonResponse(access("ready"));
    return undefined;
  });
  const host = await mount();
  await click(host.querySelector("[data-phone-enable]"));
  expect(host.querySelector("[data-phone-failure]")?.textContent).toContain("The access key stays on for this run, in case Tailscale published Delegatus anyway: other browsers on this computer need the link from the terminal.");
});
