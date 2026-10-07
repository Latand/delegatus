import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";

import { UnixRuntimeHostClient } from "@/lib/runtime/client";
import { runtimeScope } from "@/lib/runtime/contracts";
import { structuredHostsEnabled } from "@/lib/runtime/flags";
import { withJsonMembers } from "@/lib/runtime/snapshotBody";
import { structuredStartupAxis } from "@/lib/runtime/startupStatus";
import { RuntimeHost } from "@/runtime-host/host";
import { RuntimeJournal } from "@/runtime-host/journal";
import { serveRuntimeHost } from "@/runtime-host/socket";

import { GET } from "./route";

/* The route against the real host: a journal in a private directory, the
   production socket server and the production client the route constructs. */
const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-snapshot-route-"));
const socketPath = path.join(SANDBOX, "host.sock");
const previousSocket = process.env.LLV_RUNTIME_HOST_SOCKET;
let journal: RuntimeJournal;
let server: net.Server;

beforeAll(async () => {
  journal = new RuntimeJournal(path.join(SANDBOX, "events.sqlite"), { structuredHosts: false });
  for (let n = 0; n < 6; n += 1) {
    journal.append({
      scope: runtimeScope("session", `conversation-${n}`), kind: "session-status",
      payload: { conversationId: `conversation-${n}`, sessionKey: { engine: "codex", sessionId: `session-${n}` },
        hostKind: "codex-app-server", host: "hosted", turn: "idle", provenance: "structured",
        artifactPath: `/repo/session-${n}.jsonl`,
        voiceDeliveries: [{ deliveryId: `delivery-${n}`, turnId: `turn-${n}`, ready: true,
          responses: [{ responseId: `response-${n}`, text: `Відповідь ${n} — "quoted" \\ back\nline ${"x".repeat(512)}` }] }],
      },
    });
  }
  server = serveRuntimeHost(socketPath, new RuntimeHost(journal, undefined, undefined, false));
  await new Promise<void>((resolve) => server.once("listening", resolve));
  process.env.LLV_RUNTIME_HOST_SOCKET = socketPath;
});

afterAll(async () => {
  if (previousSocket === undefined) delete process.env.LLV_RUNTIME_HOST_SOCKET;
  else process.env.LLV_RUNTIME_HOST_SOCKET = previousSocket;
  await new Promise((resolve) => server.close(resolve));
  journal.close();
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

const request = (query = "", headers: Record<string, string> = {}) => new Request(`http://127.0.0.1/api/runtime/snapshot${query}`, { headers });

/** What the route wrote before it stopped parsing the frame. */
function reencoded(hostJson: string): string {
  return JSON.stringify({ ...JSON.parse(hostJson), structuredHostsEnabled: structuredHostsEnabled(), structuredStartup: structuredStartupAxis() });
}

test("each scope answers byte for byte what parsing and re-encoding the host's snapshot wrote", async () => {
  const scopes: Array<[string, string[] | undefined]> = [["", undefined], ["?view=summary", []], ["?voiceFor=conversation-3", ["conversation-3"]]];
  for (const [query, voiceBodiesFor] of scopes) {
    const response = await GET(request(query));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/json");
    /* The host caches the full and the summary frame; a frame for one
       conversation's voice is rebuilt per request and dates itself. */
    const dated = (json: string) => voiceBodiesFor?.length ? json.replace(/"serverTime":"[^"]+"/, '"serverTime":""') : json;
    expect(dated(await response.text())).toBe(dated(reencoded(journal.snapshotJson(voiceBodiesFor))));
  }
  const full = JSON.parse(await (await GET(request())).text());
  expect(full.sessions).toHaveLength(6);
  expect(full.structuredHostsEnabled).toBe(structuredHostsEnabled());
  expect(full.structuredStartup).toEqual(structuredStartupAxis());
});

test("the gzip body inflates to the same bytes", async () => {
  const response = await GET(request("", { "accept-encoding": "gzip" }));
  expect(response.headers.get("content-encoding")).toBe("gzip");
  expect(gunzipSync(Buffer.from(await response.arrayBuffer())).toString("utf8")).toBe(reencoded(journal.snapshotJson()));
});

test("the request thread neither parses nor re-encodes the snapshot frame", async () => {
  const hostJson = journal.snapshotJson();
  const parse = spyOn(JSON, "parse");
  const stringify = spyOn(JSON, "stringify");
  let parsedBytes = 0;
  let encodedBytes = 0;
  try {
    const response = await GET(request());
    for (const call of parse.mock.calls) parsedBytes += String(call[0]).length;
    for (const result of stringify.mock.results) encodedBytes += String(result.value ?? "").length;
    expect((await response.text()).length).toBeGreaterThan(hostJson.length);
  } finally {
    parse.mockRestore();
    stringify.mockRestore();
  }
  // The host process shares this test's thread, and it answers from its cache.
  expect(hostJson.length).toBeGreaterThan(4_096);
  expect(parsedBytes).toBeLessThan(1_024);
  expect(encodedBytes).toBeLessThan(1_024);
});

test("a write is in the next answer, and nothing a reader does to one answer reaches another", async () => {
  const before = await (await GET(request())).text();
  const client = new UnixRuntimeHostClient(socketPath);
  const held = await client.snapshot();
  const sessions = held.sessions.length;
  // A reader may do anything to the object it was handed.
  held.sessions.length = 0;
  (held as { snapshotSeq: number }).snapshotSeq = -1;
  expect((await client.snapshot()).sessions).toHaveLength(sessions);
  expect(await (await GET(request())).text()).toBe(before);

  journal.append({
    scope: runtimeScope("session", "conversation-new"), kind: "session-status",
    payload: { conversationId: "conversation-new", sessionKey: { engine: "codex", sessionId: "session-new" },
      hostKind: "codex-app-server", host: "hosted", turn: "idle", provenance: "structured", artifactPath: "/repo/session-new.jsonl" },
  });
  const after = await (await GET(request())).text();
  expect(after).not.toBe(before);
  expect(after).toBe(reencoded(journal.snapshotJson()));
  expect(JSON.parse(after).sessions.map((session: { conversationId: string }) => session.conversationId)).toContain("conversation-new");
  expect(JSON.parse(await (await GET(request("?view=summary"))).text()).sessions).toHaveLength(sessions + 1);
});

test("a client without the encoded read still answers the same body", async () => {
  const prototype = UnixRuntimeHostClient.prototype as { snapshotJson?: unknown };
  const original = prototype.snapshotJson;
  prototype.snapshotJson = undefined;
  try {
    expect(await (await GET(request())).text()).toBe(reencoded(journal.snapshotJson()));
  } finally {
    prototype.snapshotJson = original;
  }
});

test("a refusal by the host is still a 503 with its message", async () => {
  process.env.LLV_RUNTIME_HOST_SOCKET = path.join(SANDBOX, "absent.sock");
  try {
    const response = await GET(request());
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "runtime host is unavailable" });
  } finally {
    process.env.LLV_RUNTIME_HOST_SOCKET = socketPath;
  }
});

test("members append to an object exactly as a re-encoding would write them", () => {
  const members = { structuredHostsEnabled: true, structuredStartup: { state: "ready", note: undefined } };
  for (const objectJson of ['{"a":1,"b":[{"c":"}"}]}', "{}", JSON.stringify({ text: 'é " }\n' })]) {
    expect(withJsonMembers(objectJson, members)).toBe(JSON.stringify({ ...JSON.parse(objectJson), ...members }));
  }
  expect(withJsonMembers('{"a":1}', {})).toBe('{"a":1}');
  expect(withJsonMembers('{"a":1}', { dropped: undefined })).toBe('{"a":1}');
  // Anything that is not one object goes back to the parsing path.
  expect(withJsonMembers("[1]", members)).toBeNull();
  expect(withJsonMembers("null", members)).toBeNull();
  expect(withJsonMembers("", members)).toBeNull();
});
