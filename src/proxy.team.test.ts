import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { installSpawnCapabilityResolver, internalServiceHeaders, spawnCapabilityDigest } from "@/lib/agent/callerClaims";
import { productionViewerControlDependencies, viewerMcpBindings } from "@/lib/mcp/bindings";
import { requestRemotePipelineTick } from "@/lib/pipelines/controllerSignal";
import { viewerHealthRequestPlan, viewerRefusesUnauthorized } from "@/runtime-host/deploymentHealth";
import { claimInstall, createHandoff } from "@/lib/team/members";
import { MEMBER_COOKIE } from "@/lib/team/sessions";
import { resetTeamStoreForTests, teamStore } from "@/lib/team/store";
import { POST as inviteRoute } from "@/app/api/team/invites/route";
import { DELETE as withdrawRoute } from "@/app/api/team/invites/[id]/route";
import { POST as joinRoute } from "@/app/api/team/join/[code]/route";
import { PATCH as memberRoute } from "@/app/api/team/members/[id]/route";
import { POST as handoffRoute } from "@/app/api/team/session/handoff/route";

import { probeHeadersFrom } from "../bin/internalService.mjs";

import { proxy } from "./proxy";

/* The two layers of sign-in-and-team D1 through the real proxy: the access
   key decides who reaches the Viewer at all, and only then, on a team
   install, the identity gate decides which member a browser is. */

const TOKEN = "t".repeat(43);
const DESKTOP = { surface: "desktop" as const, browser: "chrome" as const };
const previous = { token: process.env.LLV_TOKEN, state: process.env.LLV_STATE_DIR };
let stateDir = "";

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-proxy-team-"));
  process.env.LLV_STATE_DIR = stateDir;
  process.env.LLV_TOKEN = TOKEN;
  resetTeamStoreForTests();
});

afterEach(() => {
  resetTeamStoreForTests();
  if (previous.token === undefined) delete process.env.LLV_TOKEN;
  else process.env.LLV_TOKEN = previous.token;
  process.env.LLV_STATE_DIR = previous.state;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

function get(url: string, headers: Record<string, string> = {}, method = "GET"): NextRequest {
  return new NextRequest(`https://dev.example.net${url}`, { method, headers: { host: "dev.example.net", ...headers } });
}

describe("solo install", () => {
  test("the key alone lets a browser in, exactly as before", () => {
    const response = proxy(get("/", { cookie: `llv_auth=${TOKEN}`, "sec-fetch-mode": "navigate" }));
    expect(response.status).toBe(200);
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  test("the deploy gate's keyless probe is refused at the perimeter", async () => {
    const probe = viewerHealthRequestPlan("https://dev.example.net", TOKEN, probeHeadersFrom(stateDir)).unauthorized!;
    const response = proxy(new NextRequest(probe.url, { headers: probe.headers }));
    expect(response.status).toBe(403);
    expect(viewerRefusesUnauthorized(response.status, await response.text())).toBe(true);
  });
});

describe("team install", () => {
  let cookie = "";
  beforeEach(() => {
    cookie = claimInstall(teamStore(), "Mira", DESKTOP).cookie;
  });

  test("the key without a member sends a browser to sign in", () => {
    const response = proxy(get("/", { cookie: `llv_auth=${TOKEN}`, "sec-fetch-mode": "navigate" }));
    expect(response.status).toBe(307);
    expect(new URL(response.headers.get("location")!).pathname).toBe("/sign-in");
  });

  test("a member's live session is their way past the perimeter, without the key", () => {
    const response = proxy(get("/api/files", { cookie: `${MEMBER_COOKIE}=${cookie}` }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  test("without the key or a session, the sign-in surface opens and nothing else does", () => {
    for (const pathname of ["/sign-in", "/join/abcdefghijklmnop", "/api/team/public", "/api/team/session/approval", "/brand/mark.svg"]) {
      expect([pathname, proxy(get(pathname)).headers.get("x-middleware-next")]).toEqual([pathname, "1"]);
    }
    const page = proxy(get("/", { "sec-fetch-mode": "navigate" }));
    expect(page.status).toBe(307);
    expect(new URL(page.headers.get("location")!).pathname).toBe("/sign-in");
    for (const pathname of ["/api/files", "/api/artifact?path=~/.codex/auth.json", "/_next/image?url=%2Fapi%2Ffiles&w=64&q=75"]) {
      expect([pathname, proxy(get(pathname)).status]).toEqual([pathname, 401]);
    }
  });

  test("a server action posted to a sign-in page is not part of the sign-in surface", () => {
    const action = { "next-action": "7f".repeat(21), accept: "text/x-component", origin: "https://dev.example.net" };
    for (const pathname of ["/sign-in", "/join/x"]) {
      expect([pathname, proxy(get(pathname, action, "POST")).status]).toEqual([pathname, 401]);
      expect([pathname, proxy(get(pathname, {}, "POST")).status]).toEqual([pathname, 401]);
      expect([pathname, proxy(get(pathname, { cookie: `llv_auth=${TOKEN}`, ...action }, "POST")).status]).toEqual([pathname, 401]);
      expect([pathname, proxy(get(pathname)).headers.get("x-middleware-next")]).toEqual([pathname, "1"]);
      expect([pathname, proxy(get(pathname, {}, "HEAD")).headers.get("x-middleware-next")]).toEqual([pathname, "1"]);
    }
    expect(proxy(get("/sign-in", action, "POST")).headers.get("content-type")).toContain("application/json");
    expect(proxy(get("/api/team/session/approval", {}, "POST")).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(get("/api/team/session/approval", action, "POST")).status).toBe(401);
  });

  /* Security review of #2243, round 3, P3: the endpoint exemptions were
     prefixes, so a path under them that no route serves fell through to the
     not-found page, where Next ran a header-less multipart form action. */
  test("the endpoint exemptions are the sign-in routes themselves, not every path under them", () => {
    const form = new FormData();
    form.set("$ACTION_ID_" + "7f".repeat(21), "");
    form.set("1_0", "[]");
    const post = (pathname: string) => proxy(new NextRequest(`https://dev.example.net${pathname}`, {
      method: "POST",
      headers: { host: "dev.example.net", origin: "https://dev.example.net" },
      body: form,
    }));
    for (const pathname of ["/api/team/session/nope", "/api/team/join/abc/x", "/api/team/publicx", "/api/team/public/x", "/api/team/session/approval/c_1/x", "/api/team/session/"]) {
      expect([pathname, post(pathname).status]).toEqual([pathname, 401]);
    }
    for (const pathname of [
      "/api/team/public",
      "/api/team/session/approval",
      "/api/team/session/approval/c_1",
      "/api/team/session/approve",
      "/api/team/session/handoff",
      "/api/team/session/passkey",
      "/api/team/session/sign-out",
      "/api/team/session/telegram",
      "/api/team/session/telegram/c_1",
      "/api/team/join/abcdefghijklmnop",
    ]) {
      expect([pathname, proxy(get(pathname, {}, "POST")).headers.get("x-middleware-next")]).toEqual([pathname, "1"]);
    }
    /* Every sign-in route on disk is one of them, so a new one cannot be
       left behind the gate unnoticed. */
    const routes = [...new Bun.Glob("**/route.ts").scanSync(path.join(import.meta.dir, "app/api/team"))].filter((route) => /^(public|session|join)\//.test(route));
    expect(routes.length).toBeGreaterThanOrEqual(10);
    for (const route of routes) {
      const pathname = `/api/team/${path.dirname(route).replace(/\[(\w+)\]/g, "$1")}`;
      expect([pathname, proxy(get(pathname, {}, "POST")).headers.get("x-middleware-next")]).toEqual([pathname, "1"]);
    }
  });

  test("the key and a member together pass", () => {
    const response = proxy(get("/api/files", { cookie: `llv_auth=${TOKEN}; ${MEMBER_COOKIE}=${cookie}` }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  test("a readiness probe reads with the key, and a write with only the key is refused", () => {
    expect(proxy(get("/", { authorization: `Bearer ${TOKEN}` })).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(get("/api/tasks", { authorization: `Bearer ${TOKEN}` }, "POST")).status).toBe(401);
  });

  test("the phone QR's hand-off link passes the key, then the join page opens unframed", () => {
    const { code } = createHandoff(teamStore(), teamStore().owner()!);
    const first = proxy(get(`/join/${code}?k=${TOKEN}`, { "sec-fetch-mode": "navigate" }));
    expect(first.status).toBe(307);
    const next = new URL(first.headers.get("location")!);
    expect(next.pathname).toBe(`/join/${code}`);
    expect(next.searchParams.has("k")).toBe(false);
    const page = proxy(get(`/join/${code}`, { cookie: `llv_auth=${TOKEN}`, "sec-fetch-mode": "navigate" }));
    expect(page.headers.get("x-middleware-next")).toBe("1");
    expect(page.headers.get("x-frame-options")).toBe("DENY");
  });
});

describe("team install: first-party callers name themselves and are checked", () => {
  const REAL_CAPABILITY = "R".repeat(43);
  const FORGED_CAPABILITY = { "x-llv-spawn-capability": "A".repeat(43) };
  const FORGED_SERVICE = { "x-llv-internal-service": `zz.${"0".repeat(64)}` };
  const KEY = { cookie: `llv_auth=${TOKEN}` };
  beforeEach(() => {
    claimInstall(teamStore(), "Mira", DESKTOP);
    installSpawnCapabilityResolver((digest) => (digest === spawnCapabilityDigest(REAL_CAPABILITY) ? "conversation_agent" : null));
  });
  afterEach(() => installSpawnCapabilityResolver(null));

  /* The routes a revoked member would reach as the unnamed operator: none of
     them asks who is acting, so the gate is the only thing in the way. */
  const routes: Array<[string, string]> = [
    ["GET", "/api/files"],
    ["GET", "/api/pipelines"],
    ["POST", "/api/pipelines"],
    ["POST", "/api/runtime/deployments"],
  ];
  for (const [method, pathname] of routes) {
    for (const [name, forged] of [["capability", FORGED_CAPABILITY], ["service tag", FORGED_SERVICE]] as const) {
      test(`a forged ${name} holding only the key is refused at ${method} ${pathname}`, () => {
        expect(proxy(get(pathname, KEY, method)).status).toBe(401);
        expect(proxy(get(pathname, { ...KEY, ...forged }, method)).status).toBe(401);
      });
    }
  }

  test("a forged claim on a navigation is sent to sign in", () => {
    for (const forged of [FORGED_CAPABILITY, FORGED_SERVICE]) {
      const response = proxy(get("/", { ...KEY, ...forged, "sec-fetch-mode": "navigate" }));
      expect(response.status).toBe(307);
      expect(new URL(response.headers.get("location")!).pathname).toBe("/sign-in");
    }
  });

  test("a capability the registry issued still passes, for writes too", () => {
    const response = proxy(get("/api/pipelines", { ...KEY, "x-llv-spawn-capability": REAL_CAPABILITY }, "POST"));
    expect(response.headers.get("x-middleware-next")).toBe("1");
  });

  test("the runtime host's pipeline tick passes, with the key and without one", async () => {
    for (const token of [TOKEN, null]) {
      if (token) process.env.LLV_TOKEN = token;
      else delete process.env.LLV_TOKEN;
      const statuses: number[] = [];
      await requestRemotePipelineTick(async (input, init) => {
        const response = proxy(new NextRequest(String(input), { method: init?.method, headers: init?.headers, body: init?.body as string }));
        statuses.push(response.headers.get("x-middleware-next") === "1" ? 202 : response.status);
        return new Response("{}", { status: statuses.at(-1) });
      }, { LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:18898", ...(token ? { LLV_VIEWER_CONTROL_TOKEN: token } : {}) });
      expect(statuses).toEqual([202]);
    }
  });

  /* The MCP control client, exactly as an agent's tools use it, with the
     proxy in place of the network: a read and deploy_exact_sha, on a team
     install with the key and on one without any. */
  test("an agent's MCP reads and deploy_exact_sha pass, with the key and without one", async () => {
    const realFetch = globalThis.fetch;
    const previousControl = { url: process.env.LLV_VIEWER_CONTROL_URL, token: process.env.LLV_VIEWER_CONTROL_TOKEN };
    const SHA = "4f3c1b9a8d7e6f5a4b3c2d1e0f9a8b7c6d5e4f3a";
    /* The Viewer makes the key the tag is minted from at startup. */
    internalServiceHeaders("mcp");
    try {
      for (const token of [TOKEN, null]) {
        if (token) process.env.LLV_TOKEN = token;
        else delete process.env.LLV_TOKEN;
        process.env.LLV_VIEWER_CONTROL_URL = "http://127.0.0.1:18898";
        if (token) process.env.LLV_VIEWER_CONTROL_TOKEN = token;
        else delete process.env.LLV_VIEWER_CONTROL_TOKEN;
        const reached: string[] = [];
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const response = proxy(new NextRequest(url, { method: init?.method, headers: init?.headers, body: init?.body as string }));
          if (response.headers.get("x-middleware-next") !== "1") return response;
          reached.push(`${init?.method ?? "GET"} ${new URL(url).pathname}`);
          return Response.json(init?.method === "POST" ? { deploymentId: "deploy-1", revision: SHA, state: "accepted" } : { tasks: [] });
        }) as typeof fetch;

        const control = productionViewerControlDependencies();
        expect(await control.get!("/api/tasks")).toEqual({ tasks: [] });
        const deploy = viewerMcpBindings(undefined, control, {
          callerAttribution: () => ({ kind: "manager", conversationId: "conversation_seat", role: null }),
          callerProject: () => "proj-a",
          viewerProjects: () => ["proj-a"],
          authorizedSeats: () => [{ conversationId: "conversation_seat", path: null, project: "proj-a" }],
          recordSeatDeployment: () => {},
        } as never).deploy_exact_sha;
        expect(await deploy({ revision: SHA, clientRequestId: `deploy-${token ? "key" : "open"}` })).toMatchObject({ deploymentId: "deploy-1" });
        expect(reached).toEqual(["GET /api/tasks", "POST /api/runtime/deployments"]);
      }
    } finally {
      globalThis.fetch = realFetch;
      if (previousControl.url === undefined) delete process.env.LLV_VIEWER_CONTROL_URL;
      else process.env.LLV_VIEWER_CONTROL_URL = previousControl.url;
      if (previousControl.token === undefined) delete process.env.LLV_VIEWER_CONTROL_TOKEN;
      else process.env.LLV_VIEWER_CONTROL_TOKEN = previousControl.token;
    }
  });

  test("the deploy gate's keyless probe reads the team gate's refusal as refused", async () => {
    const plan = viewerHealthRequestPlan("https://dev.example.net", TOKEN, probeHeadersFrom(stateDir));
    const probe = plan.unauthorized!;
    const response = proxy(new NextRequest(probe.url, { headers: probe.headers }));
    expect(response.status).toBe(401);
    expect(viewerRefusesUnauthorized(response.status, await response.text())).toBe(true);
  });

  test("an anonymous browser write stays refused, with the key and without one", () => {
    const browser = { origin: "https://dev.example.net", "sec-fetch-site": "same-origin" };
    expect(proxy(get("/api/pipelines/tick", { ...KEY, ...browser }, "POST")).status).toBe(401);
    delete process.env.LLV_TOKEN;
    expect(proxy(get("/api/pipelines/tick", browser, "POST")).status).toBe(401);
  });

  describe("without an access key", () => {
    beforeEach(() => {
      delete process.env.LLV_TOKEN;
      /* The Viewer makes the key the probes mint from at startup. */
      internalServiceHeaders("probe");
    });

    test("a bare GET / is sent to sign in, and the candidate's probes read", () => {
      expect(proxy(get("/", { "sec-fetch-mode": "navigate" })).status).toBe(307);
      expect(proxy(get("/")).status).toBe(401);
      const plan = viewerHealthRequestPlan("https://dev.example.net", null, probeHeadersFrom(stateDir));
      for (const probe of [plan.root, plan.capability]) {
        const response = proxy(new NextRequest(probe.url, { headers: probe.headers }));
        expect(response.headers.get("x-middleware-next")).toBe("1");
      }
    });

    test("the self-update restart probe reads the page", () => {
      const response = proxy(get("/", probeHeadersFrom(stateDir)));
      expect(response.headers.get("x-middleware-next")).toBe("1");
    });

    test("a probe's tag opens no write", () => {
      expect(proxy(get("/api/pipelines", probeHeadersFrom(stateDir), "POST")).status).toBe(401);
    });
  });
});

/* Security review of #2243, P1: invite and hand-off links carried the access
   key, and a bearer GET passes the identity gate, so whoever saw a link (a
   withdrawn one included) and every revoked member could read the whole
   install. Every credential the product hands a teammate is collected here
   the way their browser would collect it, and none of them may read. */
describe("team install: no credential a teammate holds outlives the membership", () => {
  const TAILNET = "dev.example.net";
  const SECRETS: Array<[string, string]> = [
    ["GET", "/api/artifact?path=~/.codex/auth.json"],
    ["GET", "/api/logs/stream"],
    ["GET", "/api/runtime/stream"],
    ["GET", "/api/files"],
    ["HEAD", "/api/artifact?path=~/.codex/auth.json"],
  ];
  let ownerCookie = "";
  const previousHost = process.env.LLV_TS_HOST;
  beforeEach(() => {
    process.env.LLV_TS_HOST = TAILNET;
    ownerCookie = claimInstall(teamStore(), "Mira", DESKTOP).cookie;
  });
  afterEach(() => {
    if (previousHost === undefined) delete process.env.LLV_TS_HOST;
    else process.env.LLV_TS_HOST = previousHost;
  });

  /** What a browser keeps from one response: its `llv_auth` / `llv_member` cookies. */
  class Jar {
    readonly keys = new Set<string>();
    readonly cookies = new Map<string, string>();
    link(url: string) {
      const key = new URL(url).searchParams.get("k");
      if (key) this.keys.add(key);
    }
    keep(response: Response) {
      for (const header of response.headers.getSetCookie()) {
        const [pair] = header.split(";");
        const [name, value] = pair.split("=");
        if (value) this.cookies.set(name.trim(), value.trim());
      }
    }
    /* Every way the held material can be presented: as cookies, and each
       value (a link's key, a cookie's) as a bearer. */
    presentations(): Array<Record<string, string>> {
      const cookie = [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
      const values = new Set([...this.keys, ...this.cookies.values()]);
      return [
        cookie ? { cookie } : {},
        ...[...values].map((value) => ({ ...(cookie ? { cookie } : {}), authorization: `Bearer ${value}` })),
      ];
    }
  }

  function route(pathname: string, init: { method?: string; body?: unknown; cookie?: string } = {}): NextRequest {
    return new NextRequest(`https://${TAILNET}${pathname}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: {
        host: TAILNET,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...(init.cookie ? { cookie: `${MEMBER_COOKIE}=${init.cookie}` } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
    });
  }

  /** Opens a link the way a browser does: through the proxy, following its redirect. */
  function open(url: string, jar: Jar): void {
    jar.link(url);
    const target = new URL(url);
    const first = proxy(get(`${target.pathname}${target.search}`, { "sec-fetch-mode": "navigate" }));
    jar.keep(first);
    if (first.status === 307) {
      const next = new URL(first.headers.get("location")!);
      jar.keep(proxy(get(`${next.pathname}${next.search}`, { "sec-fetch-mode": "navigate", ...jar.presentations()[0] })));
    } else {
      expect(first.headers.get("x-middleware-next")).toBe("1");
    }
  }

  function expectNoRead(jar: Jar): void {
    for (const presented of jar.presentations()) {
      for (const [method, pathname] of SECRETS) {
        const response = proxy(get(pathname, presented, method));
        expect([method, pathname, Object.keys(presented).join("+"), response.headers.get("x-middleware-next") ?? response.status])
          .toEqual([method, pathname, Object.keys(presented).join("+"), 401]);
      }
    }
  }

  test("the link of a withdrawn invite reads nothing", async () => {
    const invite = await (await inviteRoute(route("/api/team/invites", { body: { name: "Ivan" }, cookie: ownerCookie }))).json() as { id: string; url: string };
    expect(new URL(invite.url).searchParams.has("k")).toBe(false);
    const jar = new Jar();
    open(invite.url, jar);
    expect((await withdrawRoute(route(`/api/team/invites/${invite.id}`, { method: "DELETE", cookie: ownerCookie }), { params: Promise.resolve({ id: invite.id }) })).status).toBe(200);
    expectNoRead(jar);
  });

  test("a revoked member holding everything the product gave them is refused every read", async () => {
    const jar = new Jar();
    const invite = await (await inviteRoute(route("/api/team/invites", { body: { name: "Ivan" }, cookie: ownerCookie }))).json() as { url: string };
    open(invite.url, jar);
    const code = new URL(invite.url).pathname.split("/").at(-1)!;
    const joined = await joinRoute(route(`/api/team/join/${code}`, { body: { name: "Ivan" } }), { params: Promise.resolve({ code }) });
    expect(joined.status).toBe(200);
    jar.keep(joined);
    const memberCookie = jar.cookies.get(MEMBER_COOKIE)!;

    /* While a member, the session alone reads, and the phone hand-off they
       can ask for carries no key either. */
    expect(proxy(get("/api/files", { cookie: `${MEMBER_COOKIE}=${memberCookie}` })).headers.get("x-middleware-next")).toBe("1");
    const handoff = await (await handoffRoute(route("/api/team/session/handoff", { body: {}, cookie: memberCookie }))).json() as { url: string };
    expect(new URL(handoff.url).searchParams.has("k")).toBe(false);
    jar.link(handoff.url);

    const memberId = teamStore().members().find((member) => member.name === "Ivan")!.id;
    const revoked = await memberRoute(route(`/api/team/members/${memberId}`, { method: "PATCH", body: { status: "revoked" }, cookie: ownerCookie }), { params: Promise.resolve({ id: memberId }) });
    expect(revoked.status).toBe(200);
    expectNoRead(jar);
  });

  test("the owner's own phone hand-off keeps the key, as the solo QR does", async () => {
    const handoff = await (await handoffRoute(route("/api/team/session/handoff", { body: {}, cookie: ownerCookie }))).json() as { url: string };
    expect(new URL(handoff.url).searchParams.get("k")).toBe(TOKEN);
  });

  test("the operator's key still reads, and a member holding it still writes", () => {
    expect(proxy(get("/api/artifact?path=~/.codex/auth.json", { authorization: `Bearer ${TOKEN}` })).headers.get("x-middleware-next")).toBe("1");
    expect(proxy(get("/api/files", { cookie: `llv_auth=${TOKEN}; ${MEMBER_COOKIE}=${ownerCookie}` }, "POST")).headers.get("x-middleware-next")).toBe("1");
  });
});
