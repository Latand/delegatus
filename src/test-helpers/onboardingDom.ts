import { afterAll } from "bun:test";
import { Window } from "happy-dom";

/**
 * A happy-dom window for the setup guide's step tests (#1876 slice 3), with a
 * routable `fetch` that records every call. A route answers a request or
 * returns undefined to fall through to a 404. Installed once per test file,
 * before `react-dom` is loaded: it decides at load whether the window
 * supports input events, so a file imports it dynamically after this.
 */

export type FetchCall = { url: string; method: string; body: unknown };
export type FetchRoute = (url: string, init: RequestInit | undefined) => Response | Promise<Response> | undefined;

export const jsonResponse = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

export function installOnboardingDom(options: { mobile?: boolean; url?: string } = {}) {
  const dom = new Window({ url: options.url ?? "http://127.0.0.1:8898/" });
  const matchMediaStub = (query: string) => ({
    matches: Boolean(options.mobile) && query.includes("max-width"),
    media: String(query),
    onchange: null,
    addEventListener() {},
    removeEventListener() {},
    addListener() {},
    removeListener() {},
    dispatchEvent() { return false; },
  });
  (dom as unknown as { matchMedia: typeof matchMediaStub }).matchMedia = matchMediaStub;
  const calls: FetchCall[] = [];
  let route: FetchRoute = () => undefined;
  Object.assign(globalThis, {
    window: dom,
    document: dom.document,
    navigator: dom.navigator,
    Node: dom.Node,
    HTMLElement: dom.HTMLElement,
    HTMLInputElement: dom.HTMLInputElement,
    HTMLSelectElement: dom.HTMLSelectElement,
    Event: dom.Event,
    KeyboardEvent: dom.KeyboardEvent,
    MouseEvent: dom.MouseEvent,
    PointerEvent: dom.PointerEvent,
    CustomEvent: dom.CustomEvent,
    sessionStorage: dom.sessionStorage,
    localStorage: dom.localStorage,
    matchMedia: matchMediaStub,
    fetch: async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input instanceof Request ? input.url : input);
      let body: unknown = null;
      if (typeof init?.body === "string") {
        try {
          body = JSON.parse(init.body);
        } catch {
          body = init.body;
        }
      }
      calls.push({ url, method: init?.method ?? "GET", body });
      const answer = await route(url, init);
      return answer ?? jsonResponse({ error: "not routed in this test" }, 404);
    },
  });
  afterAll(() => { void dom.happyDOM.close(); });
  return {
    dom,
    calls,
    setRoute(next: FetchRoute) {
      route = next;
      calls.length = 0;
    },
  };
}

/** Let pending fetches and the renders they cause settle. */
export async function settle(rounds = 6): Promise<void> {
  for (let index = 0; index < rounds; index += 1) await new Promise((resolve) => setTimeout(resolve, 0));
}

/** Set a controlled input's value the way React hears it. */
export function typeInto(input: HTMLInputElement, value: string): void {
  let proto: object | null = Object.getPrototypeOf(input);
  while (proto && !Object.getOwnPropertyDescriptor(proto, "value")) proto = Object.getPrototypeOf(proto);
  Object.getOwnPropertyDescriptor(proto!, "value")!.set!.call(input, value);
  const view = input.ownerDocument.defaultView as unknown as { Event: typeof Event };
  input.dispatchEvent(new view.Event("input", { bubbles: true }));
}
