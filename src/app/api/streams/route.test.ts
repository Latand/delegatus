import { afterEach, beforeEach, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { NextRequest } from "next/server";

import { claimInstall, signOutSession } from "@/lib/team/members";
import { MEMBER_COOKIE } from "@/lib/team/sessions";
import { resetTeamStoreForTests, teamStore } from "@/lib/team/store";
import { createSseParser, MUX_MAX_BODY_BYTES, type SseEvent } from "@/lib/streamMux/protocol";
import { muxChannelsForTests } from "@/lib/streamMux/server";
import { config } from "@/proxy";

import { GET, POST } from "./route";

const ORIGIN = "http://127.0.0.1:8898";
const DESKTOP = { surface: "desktop" as const, browser: "chrome" as const };
const previous = {
  token: process.env.LLV_TOKEN,
  state: process.env.LLV_STATE_DIR,
  mux: process.env.LLV_STREAM_MUX,
  socket: process.env.LLV_RUNTIME_HOST_SOCKET,
};
let stateDir = "";
let serial = 0;
const leave: Array<() => Promise<void>> = [];

beforeEach(() => {
  stateDir = fs.mkdtempSync(path.join(os.tmpdir(), "llv-stream-mux-route-"));
  process.env.LLV_STATE_DIR = stateDir;
  delete process.env.LLV_TOKEN;
  delete process.env.LLV_STREAM_MUX;
  resetTeamStoreForTests();
});

afterEach(async () => {
  for (const done of leave.splice(0)) await done();
  resetTeamStoreForTests();
  for (const [name, value] of [
    ["LLV_TOKEN", previous.token],
    ["LLV_STATE_DIR", previous.state],
    ["LLV_STREAM_MUX", previous.mux],
    ["LLV_RUNTIME_HOST_SOCKET", previous.socket],
  ] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(stateDir, { recursive: true, force: true });
});

const connectionId = () => `route-connection-${String(++serial).padStart(4, "0")}`;

/** The connection as the browser's EventSource reads it. */
function connect(id: string, headers: Record<string, string>) {
  const response = GET(new NextRequest(`${ORIGIN}/api/streams?c=${id}`, { headers: { accept: "text/event-stream", ...headers } }));
  expect(response.status).toBe(200);
  const reader = response.body!.getReader();
  const parser = createSseParser();
  const decoder = new TextDecoder();
  const seen: SseEvent[] = [];
  void (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen.push(...parser.push(decoder.decode(value, { stream: true })));
    }
  })().catch(() => undefined);
  leave.push(() => reader.cancel().catch(() => undefined));
  return {
    frames: () => seen.filter((event) => event.event !== "ping" && event.event !== "e").map((event) => `${event.event} ${event.data}`),
    until: async (wanted: (frames: string[]) => boolean) => {
      for (let turn = 0; turn < 200 && !wanted(seen.map((event) => `${event.event} ${event.data}`)); turn += 1) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
  };
}

/** A body the test hands over in pieces, counting what the route took of it. */
function slowBody() {
  const encoder = new TextEncoder();
  let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
  const stream = new ReadableStream<Uint8Array>({ start(streamController) { controller = streamController; } });
  return {
    stream,
    send: (text: string) => controller!.enqueue(encoder.encode(text)),
    end: () => controller!.close(),
  };
}

function control(body: BodyInit, headers: Record<string, string>) {
  return new NextRequest(`${ORIGIN}/api/streams`, {
    method: "POST",
    headers: { host: "127.0.0.1:8898", origin: ORIGIN, "content-type": "application/json", ...headers },
    body,
    duplex: "half",
  } as ConstructorParameters<typeof NextRequest>[1]);
}

const ops = (c: string) => JSON.stringify({ c, ops: [{ op: "open", id: "1", url: "/api/logs/stream?subs=%5B%5D" }] });

test("the proxy leaves this route to gate itself, and only this route", async () => {
  /* Compiled the way Next compiles it for the server, so the check is on what runs. */
  const { getMiddlewareMatchers } = (await import("next/dist/build/analysis/get-page-static-info")) as unknown as {
    getMiddlewareMatchers(matcher: string[], nextConfig: { basePath: string }): Array<{ regexp: string }>;
  };
  const [compiled] = getMiddlewareMatchers(config.matcher, { basePath: "" });
  const proxied = (pathname: string) => new RegExp(compiled!.regexp).test(pathname);
  expect(proxied("/api/streams")).toBe(false);
  for (const pathname of ["/", "/api/logs/stream", "/api/runtime/stream", "/api/self-update/events", "/api/streams/x", "/api/streamsx", "/api/streams.json"]) {
    expect(proxied(pathname)).toBe(true);
  }
});

test("without the access key the connection and its control are refused, as every other route is", async () => {
  process.env.LLV_TOKEN = "k".repeat(43);
  expect(GET(new NextRequest(`${ORIGIN}/api/streams?c=${connectionId()}`)).status).toBe(403);
  expect((await POST(control(ops(connectionId()), {}))).status).toBe(403);
  expect(GET(new NextRequest(`${ORIGIN}/api/streams?c=${connectionId()}`, { headers: { cookie: `llv_auth=${"k".repeat(43)}` } })).status).toBe(200);
});

test("a member's channel opens while the session lives, and a control body that outlives it opens nothing", async () => {
  const signedIn = claimInstall(teamStore(), "Mira", DESKTOP);
  const cookie = { cookie: `${MEMBER_COOKIE}=${signedIn.cookie}` };

  const live = connectionId();
  const open = connect(live, cookie);
  await open.until((frames) => frames.includes("ready {}"));
  expect((await POST(control(ops(live), cookie))).status).toBe(200);
  await open.until((frames) => frames.some((frame) => frame.startsWith("up ") || frame.startsWith("end ")));
  expect(open.frames()).toEqual(["ready {}", "up \"1\""]);

  /* The control request starts while the session is live, and its body arrives after it is revoked. */
  const delayed = connectionId();
  const connection = connect(delayed, cookie);
  await connection.until((frames) => frames.includes("ready {}"));
  const body = slowBody();
  const answer = POST(control(body.stream, cookie));
  const text = ops(delayed);
  body.send(text.slice(0, 10));
  await new Promise((resolve) => setTimeout(resolve, 20));
  signOutSession(teamStore(), signedIn.member, signedIn.session);
  body.send(text.slice(10));
  body.end();
  expect((await answer).status).toBe(200);
  await connection.until((frames) => frames.some((frame) => frame.startsWith("up ") || frame.startsWith("end ")));
  /* The channel gets what a fresh plain GET with the same cookie gets: 401, and no stream. */
  expect(connection.frames()).toEqual(["ready {}", "end [\"1\",401]"]);
  expect(muxChannelsForTests(delayed)).toEqual([]);
  expect((await POST(control(ops(delayed), cookie))).status).toBe(401);
});

test("a reopened channel hands its route its last event id as Last-Event-ID", async () => {
  /* The runtime route reads its cursor from both `after` and the header, and refuses a cursor that is not one. */
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(stateDir, "runtime.sock");
  const c = connectionId();
  const connection = connect(c, {});
  await connection.until((frames) => frames.includes("ready {}"));
  const reopen = (id: string, lastEventId: string) => JSON.stringify({ c, ops: [{ op: "open", id, url: "/api/runtime/stream?after=40", lastEventId }] });
  expect((await POST(control(reopen("1", "not-a-cursor"), {}))).status).toBe(200);
  expect((await POST(control(reopen("2", "41"), {}))).status).toBe(200);
  await connection.until((frames) => frames.includes("end [\"1\",400]") && frames.includes("up \"2\""));
  expect(connection.frames()).toContain("end [\"1\",400]");
  expect(connection.frames()).toContain("up \"2\"");
});

test("a control body is limited in bytes, and reading stops at the limit", async () => {
  /* A chunked body with no length, 4 MiB of it: the route takes no more than the limit and a chunk. */
  const chunk = new Uint8Array(16 * 1024).fill(0x20);
  let pulled = 0;
  const large = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (pulled >= 4 * 1024 * 1024) {
        controller.close();
        return;
      }
      pulled += chunk.byteLength;
      controller.enqueue(chunk);
    },
  }, { highWaterMark: 0 });
  expect((await POST(control(large, {}))).status).toBe(413);
  expect(pulled).toBeGreaterThan(MUX_MAX_BODY_BYTES);
  expect(pulled).toBeLessThanOrEqual(MUX_MAX_BODY_BYTES + 4 * chunk.byteLength);

  /* Within the limit in characters, past it in bytes. */
  const c = connectionId();
  connect(c, {});
  const multibyte = JSON.stringify({ c, ops: [{ op: "close", id: "1" }], padding: "ж".repeat(150_000) });
  expect(multibyte.length).toBeLessThan(MUX_MAX_BODY_BYTES);
  expect((await POST(control(slowFrom(multibyte), {}))).status).toBe(413);

  const fits = JSON.stringify({ c, ops: [{ op: "close", id: "1" }], padding: "ж".repeat(100_000) });
  expect((await POST(control(slowFrom(fits), {}))).status).toBe(200);
});

function slowFrom(text: string): ReadableStream<Uint8Array> {
  const body = slowBody();
  body.send(text);
  body.end();
  return body.stream;
}
