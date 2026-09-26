import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { installSpawnCapabilityResolver, internalServiceHeaders, spawnCapabilityDigest } from "@/lib/agent/callerClaims";
import { productionViewerControlDependencies, viewerMcpBindings } from "@/lib/mcp/bindings";
import { requestRemotePipelineTick } from "@/lib/pipelines/controllerSignal";
import { viewerHealthRequestPlan } from "@/runtime-host/deploymentHealth";
import { claimInstall, createHandoff } from "@/lib/team/members";
import { MEMBER_COOKIE } from "@/lib/team/sessions";
import { resetTeamStoreForTests, teamStore } from "@/lib/team/store";

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

  test("a member without the key is still stopped at the perimeter", () => {
    const response = proxy(get("/api/files", { cookie: `${MEMBER_COOKIE}=${cookie}` }));
    expect(response.status).toBe(403);
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
