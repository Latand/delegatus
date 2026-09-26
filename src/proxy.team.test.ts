import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { claimInstall, createHandoff } from "@/lib/team/members";
import { MEMBER_COOKIE } from "@/lib/team/sessions";
import { resetTeamStoreForTests, teamStore } from "@/lib/team/store";

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
