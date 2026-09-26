import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { internalServiceHeaders } from "@/lib/agent/callerClaims";

import { claimInstall, createInvite, redeemJoin, revokeMember, type SignedIn } from "./members";
import { MEMBER_COOKIE } from "./sessions";
import { resetTeamStoreForTests, teamStore } from "./store";
import { sessionBoundStream } from "./streams";

/* A revoked member's open stream ends (§9): the gate judged the connection
   once, when it opened, and a live stream used to outlast the revocation. */

const DESKTOP = { surface: "desktop" as const, browser: "chrome" as const };
const RECHECK_MS = 20;
const previousState = process.env.LLV_STATE_DIR;
let stateDir = "";

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-team-streams-"));
  process.env.LLV_STATE_DIR = stateDir;
  resetTeamStoreForTests();
});

afterEach(() => {
  resetTeamStoreForTests();
  if (previousState === undefined) delete process.env.LLV_STATE_DIR;
  else process.env.LLV_STATE_DIR = previousState;
  fs.rmSync(stateDir, { recursive: true, force: true });
});

/** A source that sends a heartbeat every few milliseconds until cancelled. */
function heartbeatSource(signal: AbortSignal): { stream: ReadableStream<Uint8Array>; cancelled: () => boolean } {
  let timer: ReturnType<typeof setInterval> | null = null;
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      timer = setInterval(() => {
        try { controller.enqueue(new TextEncoder().encode(": heartbeat\n\n")); } catch { /* closed */ }
      }, 5);
      signal.addEventListener("abort", () => { if (timer) clearInterval(timer); }, { once: true });
    },
    cancel() {
      cancelled = true;
      if (timer) clearInterval(timer);
    },
  });
  return { stream, cancelled: () => cancelled };
}

function streamRequest(headers: Record<string, string>): NextRequest {
  return new NextRequest("http://127.0.0.1/api/logs/stream", { headers });
}

/** Reads until the stream ends or the deadline passes; true when it ended. */
async function endsWithin(stream: ReadableStream<Uint8Array>, ms: number, onFirstChunk: () => void): Promise<boolean> {
  const reader = stream.getReader();
  const deadline = Date.now() + ms;
  let first = true;
  while (Date.now() < deadline) {
    const next = await Promise.race([
      reader.read(),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), deadline - Date.now())),
    ]);
    if (next === null) break;
    if (next.done) return true;
    if (first) {
      first = false;
      onFirstChunk();
    }
  }
  await reader.cancel().catch(() => undefined);
  return false;
}

describe("a stream opened on a member session", () => {
  let owner: SignedIn;
  let member: SignedIn;
  beforeEach(() => {
    const store = teamStore();
    owner = claimInstall(store, "Mira", DESKTOP);
    member = redeemJoin(store, createInvite(store, owner.member, "Oleh").code, "Oleh", DESKTOP);
  });

  test("ends once the member is revoked", async () => {
    const controller = new AbortController();
    let source: ReturnType<typeof heartbeatSource> | null = null;
    const stream = sessionBoundStream(streamRequest({ cookie: `${MEMBER_COOKIE}=${member.cookie}` }), controller.signal, (signal) => {
      source = heartbeatSource(signal);
      return source.stream;
    }, RECHECK_MS);
    const ended = await endsWithin(stream, 2_000, () => revokeMember(teamStore(), owner.member, member.member));
    expect(ended).toBe(true);
    expect(source!.cancelled()).toBe(true);
  });

  test("ends once that one session is signed out", async () => {
    const stream = sessionBoundStream(streamRequest({ cookie: `${MEMBER_COOKIE}=${member.cookie}` }), new AbortController().signal, (signal) => heartbeatSource(signal).stream, RECHECK_MS);
    const ended = await endsWithin(stream, 2_000, () => teamStore().revokeSession(member.session.id, new Date().toISOString()));
    expect(ended).toBe(true);
  });

  test("stays open while the session is live", async () => {
    const stream = sessionBoundStream(streamRequest({ cookie: `${MEMBER_COOKIE}=${member.cookie}` }), new AbortController().signal, (signal) => heartbeatSource(signal).stream, RECHECK_MS);
    expect(await endsWithin(stream, RECHECK_MS * 6, () => undefined)).toBe(false);
  });

  test("a Viewer service's stream is not watched, even beside a member cookie", () => {
    let opened: ReadableStream<Uint8Array> | null = null;
    const stream = sessionBoundStream(streamRequest({ ...internalServiceHeaders("monitor"), cookie: `${MEMBER_COOKIE}=${member.cookie}` }), new AbortController().signal, (signal) => {
      opened = heartbeatSource(signal).stream;
      return opened;
    }, RECHECK_MS);
    expect(stream).toBe(opened!);
    void stream.cancel();
  });

  test("a stream with no member session (a bearer read) is not watched", () => {
    let opened: ReadableStream<Uint8Array> | null = null;
    const stream = sessionBoundStream(streamRequest({ authorization: "Bearer x" }), new AbortController().signal, (signal) => {
      opened = heartbeatSource(signal).stream;
      return opened;
    }, RECHECK_MS);
    expect(stream).toBe(opened!);
    void stream.cancel();
  });
});

test("a solo install hands back the source stream untouched", () => {
  let opened: ReadableStream<Uint8Array> | null = null;
  const stream = sessionBoundStream(streamRequest({}), new AbortController().signal, (signal) => {
    opened = heartbeatSource(signal).stream;
    return opened;
  });
  expect(stream).toBe(opened!);
  void stream.cancel();
});
