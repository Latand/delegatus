import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest, type NextResponse } from "next/server";

import { POST as claim } from "@/app/api/team/claim/route";
import { POST as createInvite } from "@/app/api/team/invites/route";
import { POST as join } from "@/app/api/team/join/[code]/route";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { setCallerConversationResolverForTests } from "@/lib/agent/operatorAuthority";
import { MEMBER_COOKIE } from "@/lib/team/sessions";
import { resetTeamStoreForTests } from "@/lib/team/store";

import { postStopAll, startStopAll, type StopAllPorts } from "./stopAll";

/* The menu's «Stop Delegatus» route: who may ask, and what it starts. The
   start itself is a port here; bin/stop-all.test.ts runs the real stop. */

let stateDir = "";
const previousStateDir = process.env.LLV_STATE_DIR;
beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stop-all-route-"));
  process.env.LLV_STATE_DIR = stateDir;
  resetTeamStoreForTests();
});
afterEach(() => {
  resetTeamStoreForTests();
  setCallerConversationResolverForTests(null);
  process.env.LLV_STATE_DIR = previousStateDir;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

type Start = { command: string; args: string[]; log: number };

function ports(overrides: Partial<StopAllPorts> = {}): StopAllPorts & { starts: Start[] } {
  const starts: Start[] = [];
  const self = {
    starts,
    launcher: async () => ({ installRoot: "/install" }),
    stateDirectory: "/state",
    runtime: "/bin/bun",
    cwd: "/release",
    exists: (file: string) => file === "/release/bin/stop-all.mjs" || file === "/install/bin/stop-all.mjs",
    openLog: () => fs.openSync(path.join(stateDir, "stop-all.log"), "w", 0o600),
    start: (command: string, args: string[], log: number) => { starts.push({ command, args, log }); return { pid: 4242 }; },
    ...overrides,
  };
  return self;
}

const browser = { host: "127.0.0.1:8898", origin: "http://127.0.0.1:8898", "sec-fetch-site": "same-origin", "content-type": "application/json" };
const post = (body: unknown, headers: Record<string, string> = browser) =>
  new NextRequest("http://127.0.0.1:8898/api/stop-all", { method: "POST", headers, body: body === undefined ? undefined : JSON.stringify(body) });

test("a confirmed stop starts the release's own stop-all on this Viewer's state directory", async () => {
  const fake = ports();
  const response = await postStopAll(post({ confirm: true, lang: "uk" }), fake);
  expect(response.status).toBe(202);
  expect(await response.json()).toEqual({ started: true, report: "stop-all.log" });
  expect(fake.starts.map(({ command, args }) => ({ command, args }))).toEqual([{ command: "/bin/bun",
    args: ["/release/bin/stop-all.mjs", "--state-dir", "/state", "--lang", "uk"] }]);
  /* The route closes its copy of the report's descriptor once the child has its own. */
  expect(() => fs.fstatSync(fake.starts[0]!.log)).toThrow();
});

test("a release without the command falls back to the install's own copy, and none answers unavailable", async () => {
  const fallback = ports({ exists: (file) => file === "/install/bin/stop-all.mjs" });
  expect(await startStopAll("en", fallback)).toEqual({ ok: true, pid: 4242 });
  expect(fallback.starts[0]!.args[0]).toBe("/install/bin/stop-all.mjs");
  expect(await startStopAll("en", ports({ exists: () => false }))).toMatchObject({ ok: false, status: 409, code: "unavailable" });
  expect(await startStopAll("en", ports({ runtime: null }))).toMatchObject({ ok: false, status: 409, code: "unavailable" });
});

test("a Viewer the delegatus command did not start refuses, and so do failures to open the report or start", async () => {
  expect(await startStopAll("en", ports({ launcher: async () => null }))).toMatchObject({ ok: false, status: 409, code: "no-launcher" });
  expect(await startStopAll("en", ports({ openLog: () => { throw new Error("EACCES"); } }))).toMatchObject({ ok: false, status: 500, code: "failed" });
  let log = -1;
  const refused = ports({ start: (_command, _args, opened) => { log = opened; throw new Error("ENOENT"); } });
  expect(await startStopAll("en", refused)).toMatchObject({ ok: false, status: 500, code: "failed" });
  expect(() => fs.fstatSync(log)).toThrow();
});

test("the route refuses without the confirmation, from another origin and from an agent, and starts nothing", async () => {
  const fake = ports();
  const unconfirmed = await postStopAll(post({ lang: "en" }), fake);
  expect(unconfirmed.status).toBe(400);
  expect(await unconfirmed.json()).toMatchObject({ code: "confirm-required" });
  expect((await postStopAll(post(undefined), fake)).status).toBe(400);
  const foreign = await postStopAll(post({ confirm: true }, { ...browser, origin: "https://elsewhere.example", "sec-fetch-site": "cross-site" }), fake);
  expect(foreign.status).toBe(403);
  setCallerConversationResolverForTests(() => "conversation_some_worker");
  const agent = await postStopAll(post({ confirm: true }, { ...browser, [VIEWER_SPAWN_CAPABILITY_HEADER]: "c".repeat(43) }), fake);
  expect(agent.status).toBe(403);
  expect(fake.starts).toEqual([]);
});

function cookieOf(response: NextResponse): string {
  const value = response.cookies.get(MEMBER_COOKIE)?.value;
  if (!value) throw new Error("the response set no member cookie");
  return value;
}
const teamCall = (url: string, body: unknown, cookie?: string) => new NextRequest(`http://127.0.0.1:8898${url}`, {
  method: "POST", body: JSON.stringify(body),
  headers: { ...browser, ...(cookie ? { cookie: `${MEMBER_COOKIE}=${cookie}` } : {}) },
});

test("on a team install only the owner's browser starts the stop", async () => {
  const owner = cookieOf(await claim(teamCall("/api/team/claim", { name: "Mira" })));
  const invite = await (await createInvite(teamCall("/api/team/invites", { name: "Oleh" }, owner))).json() as { url: string };
  const code = new URL(invite.url).pathname.split("/").pop()!;
  const member = cookieOf(await join(teamCall(`/api/team/join/${code}`, { name: "Oleh" }), { params: Promise.resolve({ code }) }));
  const fake = ports();
  const asMember = await postStopAll(post({ confirm: true }, { ...browser, cookie: `${MEMBER_COOKIE}=${member}` }), fake);
  expect(asMember.status).toBe(403);
  expect(await asMember.json()).toMatchObject({ code: "owner_required" });
  expect((await postStopAll(post({ confirm: true }), fake)).status).toBe(401);
  expect(fake.starts).toEqual([]);
  const asOwner = await postStopAll(post({ confirm: true }, { ...browser, cookie: `${MEMBER_COOKIE}=${owner}` }), fake);
  expect(asOwner.status).toBe(202);
  expect(fake.starts).toHaveLength(1);
});
