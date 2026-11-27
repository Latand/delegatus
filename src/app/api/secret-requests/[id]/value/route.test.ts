import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";

import { internalServiceHeaders } from "@/lib/agent/callerClaims";
import { VIEWER_SPAWN_CAPABILITY_HEADER } from "@/lib/agent/capabilityHeader";
import { OPERATOR_COOKIE, soloBrowserSession } from "@/lib/agent/operatorSession";
import { SqliteMcpReceiptStore } from "@/lib/mcp/server";
import { decisionsGET } from "@/lib/prototypeReview/http";
import { createSecretRequest, findSecretRequestRecord, secretRequestRecords } from "@/lib/secretRequests/store";
import type { SecretDestination, SecretFormat, SecretRequestRecord } from "@/lib/secretRequests/types";
import { SECRET_BODY_LIMIT, SECRET_BODY_TYPE, SECRET_REVISION_HEADER } from "@/lib/secretRequests/view";
import { claimInstall, createInvite, redeemJoin } from "@/lib/team/members";
import { MEMBER_COOKIE } from "@/lib/team/sessions";
import { resetTeamStoreForTests, teamStore } from "@/lib/team/store";
import { POST as decline } from "../decline/route";
import { POST as enter } from "./route";

const NOW = Date.UTC(2026, 10, 25, 18);
const ORIGIN = "http://127.0.0.1:8898";
const PROJECT = "project-fixture";
const page = { host: new URL(ORIGIN).host, origin: ORIGIN, "sec-fetch-site": "same-origin" };
const caller = { project: PROJECT,
  requester: { conversationId: "seat", role: "orchestrator", title: "Project seat", engine: "codex", model: null, seat: { conversationId: "seat", title: "Project seat" } } };
const envKeys = ["LLV_STATE_DIR", "LLV_SECRET_ROOTS", "LLV_STAGING"] as const;
let restore: (string | undefined)[];
let restoreClock: () => void;
let root: string;
let project: string;

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "secret-operator-")));
  project = path.join(root, "project");
  fs.mkdirSync(project);
  restore = envKeys.map(key => process.env[key]);
  process.env.LLV_STATE_DIR = path.join(root, "state");
  process.env.LLV_SECRET_ROOTS = project;
  delete process.env.LLV_STAGING;
  const clock = spyOn(Date, "now").mockReturnValue(NOW);
  restoreClock = () => clock.mockRestore();
  resetTeamStoreForTests();
});

afterEach(() => {
  resetTeamStoreForTests();
  restoreClock();
  envKeys.forEach((key, index) => {
    if (restore[index] === undefined) delete process.env[key];
    else process.env[key] = restore[index];
  });
  fs.rmSync(root, { recursive: true, force: true });
});

const params = (id: string) => ({ params: Promise.resolve({ id }) });
const owner = () => `${OPERATOR_COOKIE}=${soloBrowserSession()}`;
const create = (name: string, options: { format?: SecretFormat; now?: number; destination?: SecretDestination } = {}) =>
  createSecretRequest(caller, { clientRequestId: name, purpose: "Provision the fixture",
    destination: options.destination ?? { kind: "file", path: path.join(project, name) },
    format: options.format, expiresInMinutes: 5 }, options.now ?? NOW);

function request(record: SecretRequestRecord, action = "value", body?: BodyInit, override: Record<string, string> = {}) {
  return new NextRequest(`${ORIGIN}/api/secret-requests/${record.id}/${action}`, {
    method: "POST", body, headers: { ...page, cookie: owner(), "content-type": SECRET_BODY_TYPE,
      [SECRET_REVISION_HEADER]: record.destinationRevision, ...override },
    ...(body instanceof ReadableStream ? { duplex: "half" } : {}),
  });
}

function readDecisions(cookie: string, extra: Record<string, string> = {}) {
  return decisionsGET(new NextRequest(`${ORIGIN}/api/projects/decisions?project=${PROJECT}`, {
    headers: { ...page, cookie, ...extra },
  }), PROJECT);
}

async function code(response: Promise<Response>, status: number, expected: string) {
  const result = await response;
  expect(result.status).toBe(status);
  expect(result.headers.get("cache-control")).toBe("no-store");
  expect(await result.json()).toMatchObject({ code: expected });
}

test("both actions refuse cross-origin, unverified, service and capability requests before reading the body", async () => {
  const record = await create("unwritten");
  const callers = [
    { origin: "https://foreign.example", "sec-fetch-site": "cross-site" },
    { host: "foreign.example" },
    { [VIEWER_SPAWN_CAPABILITY_HEADER]: "" },
    { [VIEWER_SPAWN_CAPABILITY_HEADER]: "invalid" },
    internalServiceHeaders("mcp"),
    { cookie: "" },
  ];
  for (const who of callers) {
    const value = request(record, "value", new Uint8Array([42]), who);
    expect((await enter(value, params(record.id))).status).toBe(403);
    expect(value.bodyUsed).toBe(false);
    expect((await decline(request(record, "decline", undefined, who), params(record.id))).status).toBe(403);
    expect(findSecretRequestRecord(record.id)?.state).toBe("pending");
    expect(fs.existsSync(record.destination.path)).toBe(false);
  }
  const capabilityRead = await readDecisions(owner(), { [VIEWER_SPAWN_CAPABILITY_HEADER]: "invalid" });
  expect(await capabilityRead.json()).not.toHaveProperty("secretRequests");
});

test("a team member sees no secret requests and cannot enter or decline them", async () => {
  const target = await create("team");
  const accepted = await create("team-owner");
  const store = teamStore();
  const device = { surface: "desktop", browser: "chrome" } as const;
  const claimed = claimInstall(store, "Owner", device);
  const member = redeemJoin(store, createInvite(store, claimed.member, null).code, "Member", device);
  const memberCookie = `${MEMBER_COOKIE}=${member.cookie}`;
  const ownerCookie = `${MEMBER_COOKIE}=${claimed.cookie}`;
  const hidden = await readDecisions(memberCookie);
  expect(hidden.status).toBe(200);
  expect(await hidden.json()).not.toHaveProperty("secretRequests");
  await code(enter(request(target, "value", new Uint8Array([42]), { cookie: memberCookie }), params(target.id)), 403, "owner_required");
  await code(decline(request(target, "decline", undefined, { cookie: memberCookie }), params(target.id)), 403, "owner_required");
  expect(fs.existsSync(target.destination.path)).toBe(false);
  const ownerRead = await (await readDecisions(ownerCookie)).json();
  expect(ownerRead.secretRequests).toHaveLength(2);
  expect(ownerRead.secretRequests).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: target.id, purpose: target.purpose }), expect.objectContaining({ id: accepted.id }),
  ]));
  const saved = await enter(request(accepted, "value", new Uint8Array([43]), { cookie: ownerCookie }), params(accepted.id));
  expect(saved.status).toBe(200);
  expect(findSecretRequestRecord(accepted.id)?.transitions.at(-1)).toMatchObject({ state: "entered", actor: "owner" });

  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      store.revokeSessionsOf(claimed.member.id, new Date(NOW).toISOString());
      controller.enqueue(new Uint8Array([42]));
      controller.close();
    },
  });
  expect((await enter(request(target, "value", body, { cookie: ownerCookie }), params(target.id))).status).toBe(403);
  expect(findSecretRequestRecord(target.id)?.state).toBe("pending");
  expect(fs.existsSync(target.destination.path)).toBe(false);
});

test("owner writes at mode 600 under both umasks and a second entry leaves the file unchanged", async () => {
  for (const umask of [0, 0o077]) {
    const target = await create(`mode-${umask}`);
    const value = new TextEncoder().encode("words ☃");
    const original = process.umask(umask);
    try {
      const response = await enter(request(target, "value", value), params(target.id));
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({ secretRequests: [] });
      expect(fs.statSync(target.destination.path).mode & 0o777).toBe(0o600);
    } finally { process.umask(original); }
    await code(enter(request(target, "value", new Uint8Array([33])), params(target.id)), 409, "secret_not_pending");
    expect(fs.readFileSync(target.destination.path, "utf8")).toBe("words ☃\n");
    expect(findSecretRequestRecord(target.id)).toMatchObject({ state: "entered", length: 7 });
  }
});

test("bounds and wipes stream chunks, rejects JSON and invalid values, and fences expiry and staging", async () => {
  const line = await create("line");
  const token = await create("token", { format: "token" });
  const expired = await create("expired", { now: NOW - 5 * 60_000 });
  const first = new Uint8Array(4000).fill(65);
  const last = new Uint8Array(SECRET_BODY_LIMIT).fill(66);
  const chunks = new ReadableStream<Uint8Array>({ start(controller) {
    controller.enqueue(first);
    controller.enqueue(last);
    controller.close();
  } });
  await code(enter(request(line, "value", chunks), params(line.id)), 413, "secret_value_too_long");
  expect([first, last].every(bytes => bytes.every(byte => byte === 0))).toBe(true);
  await code(enter(request(line, "value", JSON.stringify({ data: "discarded" }), { "content-type": "application/json" }), params(line.id)), 400, "secret_value_format");
  await code(enter(request(line, "value", new Uint8Array(4097).fill(33)), params(line.id)), 413, "secret_value_too_long");
  await code(enter(request(line, "value", new Uint8Array([33, 0])), params(line.id)), 400, "secret_value_format");
  await code(enter(request(token, "value", new TextEncoder().encode("with space")), params(token.id)), 400, "secret_value_format");
  await code(enter(request(line, "value", new Uint8Array([33]), { [SECRET_REVISION_HEADER]: "0".repeat(64) }), params(line.id)), 409, "secret_destination_changed");
  await code(enter(request(expired, "value", new Uint8Array([33])), params(expired.id)), 409, "secret_expired");
  expect(findSecretRequestRecord(expired.id)?.state).toBe("expired");
  process.env.LLV_STAGING = "1";
  await code(enter(request(line, "value", new Uint8Array([33])), params(line.id)), 409, "staging");
  await code(decline(request(line, "decline"), params(line.id)), 409, "staging");
  expect(fs.readdirSync(project)).toEqual([]);
});

test("a destination change returns the new facts; decline is terminal", async () => {
  const filename = path.join(project, ".env");
  const target = await create("dotenv", { destination: { kind: "env", path: filename, key: "FIXTURE" } });
  fs.writeFileSync(filename, "FIXTURE=original\n");
  const changed = await enter(request(target, "value", new Uint8Array([42])), params(target.id));
  expect(changed.status).toBe(409);
  expect(await changed.json()).toMatchObject({ code: "secret_destination_changed", secretRequests: [{
    id: target.id, destination: { path: filename, effect: "env-replace" },
  }] });
  expect(fs.readFileSync(filename, "utf8")).toBe("FIXTURE=original\n");
  const response = await decline(request(target, "decline"), params(target.id));
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ secretRequests: [] });
  expect(findSecretRequestRecord(target.id)?.state).toBe("cancelled");
  await code(enter(request(target, "value", new Uint8Array([42])), params(target.id)), 409, "secret_not_pending");
  await code(decline(request(target, "decline"), params(target.id)), 409, "secret_not_pending");
  expect(fs.readFileSync(filename, "utf8")).toBe("FIXTURE=original\n");
});

test("a random canary exists only in the private destination", async () => {
  const canary = randomBytes(23).toString("hex");
  const filename = path.join(project, ".env");
  const records = path.join(root, "state", "mcp-receipts.sqlite");
  const receipts = new SqliteMcpReceiptStore(records);
  const transcript = path.join(root, "conversation.jsonl");
  fs.writeFileSync(transcript, JSON.stringify({ type: "message", text: "Request submitted." }) + "\n");
  const expectedTranscript = fs.readFileSync(transcript);
  const output: unknown[][] = [];
  const capture = (...args: unknown[]) => { output.push(args); };
  const logs = (["info", "log", "warn", "error", "debug", "trace"] as const).map(method => spyOn(console, method).mockImplementation(capture));
  const fakeFetch = Object.assign(async () => new Response(null, { status: 500 }), { preconnect: globalThis.fetch.preconnect });
  const sends = spyOn(globalThis, "fetch").mockImplementation(fakeFetch);
  try {
    const target = await create("canary", { destination: { kind: "env", path: filename, key: "FIXTURE" } });
    const response = await enter(request(target, "value", new TextEncoder().encode(canary)), params(target.id));
    expect(response.status).toBe(200);
    const texts = [await response.text(), await (await readDecisions(owner())).text(), JSON.stringify(await secretRequestRecords()), JSON.stringify(output)];
    for (const text of texts) expect(text.includes(canary)).toBe(false);
    expect(sends).not.toHaveBeenCalled();
    expect(fs.readFileSync(transcript).equals(expectedTranscript)).toBe(true);
    expect(fs.readFileSync(filename).includes(canary)).toBe(true);
    for (const entry of fs.readdirSync(root, { recursive: true, withFileTypes: true })) {
      const file = path.join(entry.parentPath, entry.name);
      if (entry.isFile() && file !== filename) expect(fs.readFileSync(file).includes(canary)).toBe(false);
    }
  } finally {
    sends.mockRestore();
    for (const log of logs) log.mockRestore();
    receipts.close();
  }
});
