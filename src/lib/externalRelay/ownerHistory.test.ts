import { afterAll, expect, spyOn, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { PairedRelay } from "./store";
import type { OwnerDestinationReason } from "./ownerDestination";
import { historyDouble } from "./ownerHistory.fixture";
import { readOwnerHistory, readOwnerGroups, readOwnerGroupMessages } from "./ownerHistory";
import { CloneDirectory } from "./cloneDirectory";
import { knownRelay } from "./knownRelays";
import os from "node:os";

const double = await historyDouble();
afterAll(() => double.close());
let now = Date.parse("2026-10-12T09:00:00Z");
let zone: string | null = "Europe/Kyiv";
let enabled = true;
let resetCount = 0;
const ports = { switches: () => ({ owner_tools: enabled }), relays: () => [double.relay], timeZone: () => zone, now: () => now };
const reset = () => { double.relay.id = `paired-${++resetCount}`; double.state.forced = null; double.state.afterHistoryResponse = null; double.state.admissions = 0; now = Date.parse("2026-10-12T09:00:00Z"); double.state.now = now; zone = "Europe/Kyiv"; enabled = true; };

test("a supported persisted directory authorizes the existing read through a service-answered clone", async () => {
  reset();
  const relay = structuredClone(double.relay);
  relay.targets.forEach(t => { t.answered_by = "service"; t.engine = null; t.model = null; });
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "history-clone-")), file = path.join(root, "directory.json");
  const local = { ...ports, relays: () => [relay] };
  try {
    expect(await readOwnerHistory({ action: "groups" }, local)).toMatchObject({ reason: "no_target" });
    fs.writeFileSync(file, JSON.stringify({ v: 1, entries: [{ relayId: relay.id, apiBase: relay.api_base, pairedAt: relay.pairedAt,
      attemptedAt: now, snapshot: { relayId: relay.id, apiBase: relay.api_base, pairedAt: relay.pairedAt,
        fetchedAt: now, supported: true, targets: [{ target_id: "first", name: "Read clone", active: true, chats: [] }] } }] }));
    const directory = new CloneDirectory({ file, relays: local.relays, now: () => now, origin: knownRelay("celestia")!.origin });
    const reading = { ...local, cloneTarget: (relays: PairedRelay[]) => directory.readTarget(relays) };
    expect(await readOwnerHistory({ action: "groups" }, reading)).toMatchObject({ available: true });
    expect(await readOwnerHistory({ action: "messages", chat: "-101" }, reading)).toMatchObject({ available: true });
    relay.paused = true;
    expect(await readOwnerHistory({ action: "groups" }, reading)).toMatchObject({ reason: "paused" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("OFF and missing time zone make no request", async () => {
  reset(); const before = double.state.requests; enabled = false;
  expect(await readOwnerHistory({ action: "groups" }, ports)).toMatchObject({ available: false, reason: "switch_off" });
  expect(await readOwnerHistory({ action: "messages", chat: "-101" }, ports)).toMatchObject({ reason: "switch_off" });
  enabled = true; zone = null;
  expect(await readOwnerHistory({ action: "messages", chat: "-101" }, ports)).toMatchObject({ reason: "time_zone_unknown" });
  expect(double.state.requests).toBe(before);
});
test("owner-tools OFF before response delivery discards groups and messages", async () => {
  for (const input of [{ action: "groups" }, { action: "messages", chat: "-101" }]) {
    reset();
    const before = double.state.requests;
    double.state.afterHistoryResponse = () => { enabled = false; };
    const answer = await readOwnerHistory(input, ports);
    expect(answer).toMatchObject({ available: false, reason: "switch_off" });
    expect(JSON.stringify(answer)).not.toContain("Example group");
    expect(JSON.stringify(answer)).not.toContain("Synthetic message");
    expect(double.state.requests).toBe(before + 1);
  }
});
test("list and today have exact wire, shape, stripped author ids and stable later continuation", async () => {
  reset();
  expect(await readOwnerHistory({ action: "groups" }, ports)).toMatchObject({ available: true, groups: [1, 2, 3].map(n => ({ chat: String(-100-n), title: `Example group ${n}` })) });
  expect(double.state.exchanges.at(-1)!.request).toEqual({ method: "GET", path: "/v1/targets/first/owner/groups", query: [] });
  const page = await readOwnerHistory({ action: "messages", chat: "-101", limit: 1 }, ports);
  expect(page).toMatchObject({ available: true, timeZone: "Europe/Kyiv" });
  if (!page.available || !("messages" in page)) throw new Error("missing page");
  expect(JSON.stringify(page)).not.toContain("user_id"); expect(page.privacy).toContain("bridge reports");
  expect(page.nextCursor).toBeString();
  zone = "America/New_York"; now += 86400000; double.state.now = now;
  const second = await readOwnerHistory({ action: "messages", cursor: page.nextCursor! }, ports);
  expect(double.state.exchanges.at(-1)!.request.query).toEqual([["tz", "Europe/Kyiv"], ["from", "2026-10-12"], ["to", "2026-10-12"], ["cursor", "10"]]);
  expect(second).toMatchObject({ available: true, nextCursor: null });
  const before = double.state.requests;
  for (const input of [{ action: "messages", cursor: "broken" }, { action: "messages", chat: "-102", cursor: page.nextCursor }, { action: "messages", chat: "invalid" }])
    expect(await readOwnerHistory(input, ports)).toMatchObject({ reason: "invalid_arguments" });
  expect(double.state.requests).toBe(before);
});
test("HTTP refusals discard wire bodies, and 429 gates both reads until Retry-After", async () => {
  for (const [status, code, reason] of [[403,"forbidden","forbidden"],[408,"timeout","request_timeout"],[502,"gateway","bad_gateway"],[504,"timeout","gateway_timeout"],[418,"other","http_error"],[400,"malformed","invalid_arguments"],[422,"malformed","invalid_arguments"],[401,"unauthorized","unauthorized"],[404,"not_found","not_found"],[426,"unsupported_version","unsupported_version"],[500,"server_error","service_error"],[503,"server_error","service_error"]] as const) {
    reset(); double.state.forced = { status, body: { error: { code, message: "Synthetic private sentinel" } } };
    const answer = await readOwnerHistory({ action: "groups" }, ports);
    expect(answer).toMatchObject({ available: false, reason }); expect(JSON.stringify(answer)).not.toContain("sentinel");
    if (!answer.available) expect(answer.note).toContain(`HTTP ${status}`);
  }
  reset(); double.state.forced = { status: 429, headers: { "Retry-After": "2" }, body: { error: { code: "rate_limited", message: "rate limited" } } };
  expect(await readOwnerHistory({ action: "groups" }, ports)).toMatchObject({ reason: "rate_limited", retryAfterSeconds: 2 });
  const before = double.state.requests; double.state.forced = null;
  expect(await readOwnerHistory({ action: "messages", chat: "-101" }, ports)).toMatchObject({ reason: "rate_limited" });
  expect(double.state.requests).toBe(before); now += 2000;
  expect(await readOwnerHistory({ action: "groups" }, ports)).toMatchObject({ available: true });
});
test("strict response schema fails closed", async () => {
  reset(); const base = await readOwnerGroupMessages(double.relay, "first", "-101", { tz: "Europe/Kyiv" });
  for (const body of [{ ...base, extra: true }, { ...base, next_cursor: 12 }, { ...base, messages: [{ ...base.messages[0], file_id: "synthetic" }] }]) {
    double.state.forced = { body };
    expect(await readOwnerHistory({ action: "messages", chat: "-101" }, ports)).toMatchObject({ reason: "malformed_response" });
  }
});
test("recorded cross-check against the documented synthetic double", async () => {
  reset(); double.state.now = Date.parse("2026-10-12T09:00:00Z");
  const scenarios: unknown[] = [];
  async function record(name: string, runs: Array<() => Promise<unknown>>, precondition?: string) {
    const reads = [];
    for (const run of runs) {
      double.state.exchanges = [];
      const service_now = new Date(double.state.now).toISOString();
      const outcome = await run();
      reads.push({ service_now, exchanges: double.state.exchanges, outcome });
    }
    scenarios.push({ name, ...(precondition ? { precondition } : {}), reads });
  }
  const groups = () => readOwnerGroups(double.relay, "first").then(() => ({ available: true }));
  const messages = (query: Parameters<typeof readOwnerGroupMessages>[3]) => readOwnerGroupMessages(double.relay, "first", "-101", query).then(p => ({ available: true, next_cursor: p.next_cursor }));
  const safe = async (run: () => Promise<unknown>) => { try { return await run(); } catch (e) { return { available: false, code: (e as {code:string}).code }; } };
  await record("list", [groups]);
  await record("today plus next page", [() => messages({ tz: "Europe/Kyiv", limit: 1 }), () => messages({ tz: "Europe/Kyiv", from: "2026-10-12", to: "2026-10-12", cursor: "10" })]);
  await record("explicit three-day range", [() => messages({ tz: "Europe/Kyiv", from: "2026-10-10", to: "2026-10-12", limit: 2 })]);
  double.state.now += 86400000;
  await record("continuation in later call", [() => messages({ tz: "Europe/Kyiv", from: "2026-10-10", to: "2026-10-12", cursor: "5" })]);
  await record("forbidden group", [() => safe(() => readOwnerGroupMessages(double.relay, "first", "-999", { tz: "Europe/Kyiv" }))]);
  await record("bad timezone", [() => safe(() => messages({ tz: "Invalid/Zone" }))]);
  await record("overlong range", [() => safe(() => messages({ tz: "Europe/Kyiv", from: "2026-09-01", to: "2026-10-12" }))]);
  await record("malformed arguments", [() => safe(() => messages({ tz: "Europe/Kyiv", limit: 101 }))]);
  double.state.minute = Math.floor(double.state.now / 60000); double.state.admissions = 60; now = double.state.now;
  await record("rate limit", [() => readOwnerHistory({ action: "groups" }, ports), () => readOwnerHistory({ action: "groups" }, ports)], "60 admissions in the current minute, shared by both history endpoints");
  now += 60000; double.state.now = now;
  // The retry is a later read of the same scenario, after its cooldown has elapsed.
  double.state.exchanges = [];
  const retry = await readOwnerHistory({ action: "groups" }, ports);
  (scenarios.at(-1) as { reads: unknown[] }).reads.push({ service_now: new Date(double.state.now).toISOString(), exchanges: double.state.exchanges, outcome: { available: retry.available } });
  const capture = {
    spec: { document: "docs/design/relay-owner-group-history.md", revision: "507ac6e0", bytes: 34077,
      sha256: "becc3785513c31c22411a00af4f8b7a2b3eea6348ef0c4ec097670d18fed5996" },
    recorded_against: "local double (ownerHistory.fixture.ts); no call to Celestia",
    request_headers: { "Authorization": "Bearer [redacted]", "Delegatus-Relay-Version": "1" }, scenarios,
  };
  const bytes = JSON.stringify(capture, null, 2) + "\n";
  expect(scenarios).toHaveLength(9);
  // A filtered capture run must validate every scenario before publishing bytes.
  const recorded = scenarios as Array<{ reads: Array<{ exchanges: Array<{ response: { status: number } }> }> }>;
  expect(recorded.map(s => s.reads.map(r => r.exchanges.map(e => e.response.status)))).toEqual([[[200]], [[200], [200]], [[200]], [[200]], [[404]], [[422]], [[422]], [[400]], [[429], [], [200]]]);
  expect(bytes).not.toContain(double.credential);
  const file = path.join(import.meta.dir, "../../..", "evidence/external-relay/install_owner_group_history.json");
  if (process.env.LLV_RELAY_WIRE_OUTPUT_HISTORY) fs.writeFileSync(file, bytes);
  expect(bytes).toBe(fs.readFileSync(file, "utf8"));
});

test("destination refusals, optional dates and retained UTC media fields", async () => {
  reset(); const before = double.state.requests;
  const cases: Array<[PairedRelay[], OwnerDestinationReason]> = [[[], "no_relay"], [[{ ...double.relay, paused: true }], "paused"], [[{ ...double.relay, targets: [] }], "no_target"],
    [[{ ...double.relay, owner: { ...double.relay.owner, id: "invalid" } }], "invalid_owner"],
    [[{ ...double.relay, targets: [{ ...double.relay.targets[0]!, engine: null }] }], "not_configured"]];
  for (const [relays, reason] of cases) {
    expect(await readOwnerHistory({ action: "groups" }, { ...ports, relays: () => [...relays] })).toMatchObject({ available: false, reason });
  }
  expect(double.state.requests).toBe(before);
  for (const dates of [{ from: "2026-10-10" }, { to: "2026-10-10" }]) {
    const page = await readOwnerHistory({ action: "messages", chat: "-101", ...dates }, ports);
    expect(page.available).toBe(true);
    expect(double.state.exchanges.at(-1)!.request.query).toEqual([["tz", "Europe/Kyiv"], ...Object.entries(dates)]);
  }
  const page = await readOwnerHistory({ action: "messages", chat: "-101" }, ports);
  expect(page).toMatchObject({ available: true, messages: [
    { messageId: 10, sentAt: "2026-10-12T09:00:00Z", author: { name: "Member one", username: null }, fromAssistant: false, topicId: null, replyToMessageId: null, media: null, truncated: false },
    { messageId: 11, truncated: true }, { messageId: 12, text: "Synthetic message 12", media: { kind: "voice", description: "Synthetic voice description" } },
  ] });
});
test("body Retry-After wins, minimum cooldown and another pairing remain independent", async () => {
  reset(); double.state.forced = { status: 429, headers: { "Retry-After": "30" }, body: { error: { code: "rate_limited", retry_after_s: 1 } } };
  expect(await readOwnerHistory({ action: "groups" }, ports)).toMatchObject({ reason: "rate_limited", retryAfterSeconds: 1 });
  const before = double.state.requests; double.state.forced = null;
  expect(await readOwnerHistory({ action: "groups" }, { ...ports, relays: () => [{ ...double.relay, id: "other" }] })).toMatchObject({ available: true });
  expect(double.state.requests).toBe(before + 1);
  now += 1000;
  expect(await readOwnerHistory({ action: "groups" }, ports)).toMatchObject({ available: true });
});
test("network loss and redirects retain their distinct causes without a body", async () => {
  for (const forced of [{ drop: true }, { status: 302, headers: { Location: "https://elsewhere.example" }, body: { text: "Synthetic sentinel" } }]) {
    reset(); double.state.forced = forced;
    expect(await readOwnerHistory({ action: "groups" }, ports)).toMatchObject({ available: false, reason: "drop" in forced ? "connect_error" : "http_error" });
  }
});
test("reads log one allowlisted failure line and never store history content", async () => {
  const { spyOn } = await import("bun:test");
  reset();
  const logs: unknown[][] = [];
  const spies = ["log", "error", "warn", "info", "debug"].map(k => spyOn(console, k as "log").mockImplementation((...args) => { logs.push(args); }));
  const directory = process.env.LLV_STATE_DIR!;
  function files(root: string): [string, string][] {
    if (!fs.existsSync(root)) return [];
    return fs.readdirSync(root, { withFileTypes: true }).flatMap(e => e.isDirectory() ? files(path.join(root, e.name)) : [[path.join(root, e.name), fs.readFileSync(path.join(root, e.name)).toString("base64")]] as [string,string][]);
  }
  const before = files(directory);
  try {
    expect((await readOwnerHistory({ action: "messages", chat: "-101" }, ports)).available).toBe(true);
    double.state.forced = { body: { private: "Synthetic schema sentinel" } };
    expect(await readOwnerHistory({ action: "groups" }, ports)).toMatchObject({ reason: "malformed_response" });
    expect(logs).toHaveLength(1);
    const [line] = logs[0]!;
    expect(typeof line).toBe("string");
    expect(line as string).toStartWith("[relay owner-history] ");
    const record = JSON.parse((line as string).slice("[relay owner-history] ".length));
    expect(record).toEqual({ cause: "malformed_response", routeKind: "groups", status: 200,
      elapsedMs: expect.any(Number), loopGapMs: expect.any(Number) });
    expect(files(directory)).toEqual(before);
  } finally { for (const spy of spies) spy.mockRestore(); }
});

test("invalid JSON and an active trickle both stay bounded through real HTTP", async () => {
  const http = await import("node:http");
  let trickle = false, status = 200;
  const server = http.createServer((req, res) => {
    req.socket.on("error", () => {});
    res.writeHead(status, { "content-type": "application/json" });
    if (!trickle) { res.end("not json"); return; }
    res.write("{");
    const timer = setInterval(() => res.write(" "), 50);
    res.on("close", () => clearInterval(timer));
  });
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); if (!address || typeof address === "string") throw new Error("missing address");
  const relay = { ...double.relay, api_base: `http://127.0.0.1:${address.port}/v1` };
  try {
    const isolated = { ...ports, relays: () => [relay] }; reset();
    expect(await readOwnerHistory({ action: "groups" }, isolated)).toMatchObject({ reason: "malformed_response" });
    trickle = true;
    const trickleResult = await readOwnerHistory({ action: "groups" }, isolated);
    expect(trickleResult.available).toBe(false);
    if (!trickleResult.available) expect(["deadline_exceeded", "deadline_loop_stalled"]).toContain(trickleResult.reason);
    status = 502; trickle = false;
    for (const input of [{ action: "groups" }, { action: "messages", chat: "-101" }]) {
      const answer = await readOwnerHistory(input, isolated);
      expect(answer).toMatchObject({ reason: "bad_gateway", note: "The Celestia gateway returned an invalid upstream response. HTTP 502." });
    }
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});

test("a later process can continue across local midnight and DST days keep their offsets", async () => {
  reset(); now = Date.parse("2026-10-12T20:59:50Z"); double.state.now = now;
  const page = await readOwnerHistory({ action: "messages", chat: "-101", limit: 1 }, ports);
  if (!page.available || !("messages" in page)) throw new Error("missing page");
  now = Date.parse("2026-10-12T21:00:10Z"); double.state.now = now;
  const laterReader = { ...ports, timeZone: () => "America/New_York" };
  expect(await readOwnerHistory({ action: "messages", cursor: page.nextCursor! }, laterReader)).toMatchObject({ available: true, timeZone: "Europe/Kyiv", nextCursor: null });
  expect(double.state.exchanges.at(-1)!.request.query).toEqual([["tz", "Europe/Kyiv"], ["from", "2026-10-12"], ["to", "2026-10-12"], ["cursor", "10"]]);
  zone = "Europe/Kyiv";
  const dst = await readOwnerHistory({ action: "messages", chat: "-101", from: "2026-03-29", to: "2026-03-29" }, ports);
  expect(dst).toMatchObject({ available: true, start: "2026-03-29T00:00:00+02:00", end: "2026-03-30T00:00:00+03:00", nextCursor: null });
  if (!dst.available || !("start" in dst)) throw new Error("missing page");
  expect(Date.parse(dst.end) - Date.parse(dst.start)).toBe(23 * 3600000);
});


test("oversized responses are distinct from malformed bodies on both routes", async () => {
  for (const input of [{ action: "groups" }, { action: "messages", chat: "-101" }]) {
    reset();
    double.state.forced = { body: { private: "Synthetic oversized sentinel".repeat(50000) } };
    expect(await readOwnerHistory(input, ports)).toMatchObject({ available: false, reason: "response_too_large" });
  }
});


test("DNS, socket and TLS failures keep safe distinct reasons on each route", async () => {
  const dns = (await import("node:dns/promises")).default;
  const http = (await import("node:http")).default;
  const https = (await import("node:https")).default;
  for (const input of [{ action: "groups" }, { action: "messages", chat: "-101" }]) {
    reset();
    const logs: string[] = [];
    const log = spyOn(console, "warn").mockImplementation(line => { logs.push(String(line)); });
    const lookup = spyOn(dns, "lookup").mockRejectedValue(Object.assign(new Error("Synthetic private DNS sentinel"), { code: "ENOTFOUND" }));
    try {
      const relays = () => [{ ...double.relay, api_base: "https://fixture.invalid/v1" }];
      expect(await readOwnerHistory(input, { ...ports, relays })).toMatchObject({ reason: "dns_error" });
      expect(logs).toHaveLength(1);
      expect(JSON.parse(logs[0]!.slice("[relay owner-history] ".length))).toMatchObject({ cause: "dns_error", routeKind: input.action, status: null });
      expect(logs.join()).not.toContain("sentinel");
    } finally { lookup.mockRestore(); log.mockRestore(); }
    for (const [transport, code, expected, base] of [
      [http, "ECONNREFUSED", "connect_error", double.relay.api_base],
      [https, "DEPTH_ZERO_SELF_SIGNED_CERT", "tls_error", "https://127.0.0.1/v1"],
      [http, "UNKNOWN_FAILURE", "transport_error", double.relay.api_base],
    ] as const) {
      logs.length = 0;
      const log = spyOn(console, "warn").mockImplementation(line => { logs.push(String(line)); });
      const request = spyOn(transport, "request").mockImplementation(() => { throw Object.assign(new Error("Synthetic credential and title sentinel"), { code }); });
      try {
        expect(await readOwnerHistory(input, { ...ports, relays: () => [{ ...double.relay, api_base: base }] })).toMatchObject({ available: false, reason: expected });
        expect(logs).toHaveLength(1);
        expect(JSON.parse(logs[0]!.slice("[relay owner-history] ".length))).toMatchObject({ cause: expected, routeKind: input.action, status: null });
        expect(logs.join()).not.toContain("sentinel");
      } finally { request.mockRestore(); log.mockRestore(); }
    }
  }
});

test("HTTP and body failures log only allowlisted fields, once, on both routes", async () => {
  for (const input of [{ action: "groups" }, { action: "messages", chat: "-101" }]) {
    for (const status of [302, 400, 401, 403, 404, 408, 418, 422, 426, 429, 500, 502, 503, 504, 200]) {
      reset();
      double.state.forced = { status, body: { error: { code: "Synthetic private error sentinel", message: "Synthetic private message sentinel" }, title: "Synthetic private title sentinel" } };
      const logs: string[] = [];
      const log = spyOn(console, "warn").mockImplementation(line => { logs.push(String(line)); });
      try {
        const answer = await readOwnerHistory(input, ports);
        expect(answer.available).toBe(false);
        expect(logs).toHaveLength(1);
        const record = JSON.parse(logs[0]!.slice("[relay owner-history] ".length));
        expect(Object.keys(record).sort()).toEqual(["cause", "elapsedMs", "loopGapMs", "routeKind", "status"]);
        expect(record).toMatchObject({ cause: answer.available ? "unexpected_success" : answer.reason, routeKind: input.action, status });
        for (const forbidden of ["sentinel", double.credential, double.relay.id, "-101", "first", "127.0.0.1"]) {
          expect(logs.join()).not.toContain(forbidden);
          expect(JSON.stringify(answer)).not.toContain(forbidden);
        }
        if (status === 429) {
          logs.length = 0;
          expect(await readOwnerHistory(input, ports)).toMatchObject({ reason: "rate_limited" });
          expect(logs).toHaveLength(1);
        }
      } finally { log.mockRestore(); }
    }
  }
});


test("DNS-inclusive deadlines report elapsed time and loop stalls without late emission", async () => {
  const dns = (await import("node:dns/promises")).default;
  const https = (await import("node:https")).default;
  for (const action of ["groups", "messages"] as const) {
    for (const stalled of [false, true]) {
      reset();
      let clockNow = 0;
      const timers = new Map<number, () => void>();
      let poll: (() => void) | undefined;
      let release!: (addresses: Array<{ address: string; family: number }>) => void;
      const held = new Promise<Array<{ address: string; family: number }>>(resolve => { release = resolve; });
      const lookup = spyOn(dns, "lookup").mockImplementation((() => held) as unknown as typeof dns.lookup);
      const request = spyOn(https, "request");
      const logs: string[] = [];
      const log = spyOn(console, "warn").mockImplementation(line => { logs.push(String(line)); });
      try {
        const result = readOwnerHistory({ action, ...(action === "messages" ? { chat: "-101" } : {}) }, {
          ...ports, relays: () => [{ ...double.relay, api_base: "https://fixture.invalid/v1" }],
          clock: { now: () => clockNow,
            later(run, ms) { timers.set(ms, run); return () => { timers.delete(ms); }; },
            afterPoll(run) { poll = run; return () => { poll = undefined; }; },
          },
        });
        clockNow = stalled ? 6800 : 4000;
        // A healthy loop has serviced every heartbeat before the deadline.
        if (!stalled) { for (let at = 100; at <= 4000; at += 100) { clockNow = at; timers.get(100)!(); } }
        timers.get(4000)!();
        if (stalled) { expect(logs).toEqual([]); poll!(); }
        const expected = stalled ? "deadline_loop_stalled" : "deadline_exceeded";
        const answer = await result;
        expect(answer).toMatchObject({ available: false, reason: expected });
        if (!answer.available) expect(answer.note).toContain(stalled ? "loop was stalled" : "four-second deadline");
        expect(logs).toHaveLength(1);
        expect(JSON.parse(logs[0]!.slice("[relay owner-history] ".length))).toEqual({ cause: expected, routeKind: action,
          status: null, elapsedMs: stalled ? 6800 : 4000, loopGapMs: stalled ? 6700 : 0 });
        release([{ address: "127.0.0.1", family: 4 }]);
        await Promise.resolve(); await Promise.resolve();
        expect(request).not.toHaveBeenCalled();
        expect(timers.size).toBe(0);
        expect(poll).toBeUndefined();
      } finally { release([]); lookup.mockRestore(); request.mockRestore(); log.mockRestore(); }
    }
  }
});
