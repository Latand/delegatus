import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import type { PairedRelay } from "./store";
import type { OwnerDestinationReason } from "./ownerDestination";
import { historyDouble } from "./ownerHistory.fixture";
import { readOwnerHistory, readOwnerGroups, readOwnerGroupMessages } from "./ownerHistory";

const double = await historyDouble();
afterAll(() => double.close());
let now = Date.parse("2026-10-12T09:00:00Z");
let zone: string | null = "Europe/Kyiv";
let enabled = true;
let resetCount = 0;
const ports = { switches: () => ({ owner_tools: enabled }), relays: () => [double.relay], timeZone: () => zone, now: () => now };
const reset = () => { double.relay.id = `paired-${++resetCount}`; double.state.forced = null; double.state.admissions = 0; now = Date.parse("2026-10-12T09:00:00Z"); double.state.now = now; zone = "Europe/Kyiv"; enabled = true; };

test("OFF and missing time zone make no request", async () => {
  reset(); const before = double.state.requests; enabled = false;
  expect(await readOwnerHistory({ action: "groups" }, ports)).toMatchObject({ available: false, reason: "switch_off" });
  expect(await readOwnerHistory({ action: "messages", chat: "-101" }, ports)).toMatchObject({ reason: "switch_off" });
  enabled = true; zone = null;
  expect(await readOwnerHistory({ action: "messages", chat: "-101" }, ports)).toMatchObject({ reason: "time_zone_unknown" });
  expect(double.state.requests).toBe(before);
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
  for (const input of [{ action: "messages", cursor: "broken" }, { action: "messages", chat: "-101", cursor: page.nextCursor }, { action: "messages", chat: "invalid" }])
    expect(await readOwnerHistory(input, ports)).toMatchObject({ reason: "invalid_arguments" });
  expect(double.state.requests).toBe(before);
});
test("HTTP refusals discard wire bodies, and 429 gates both reads until Retry-After", async () => {
  for (const [status, code, reason] of [[400,"malformed","invalid_arguments"],[422,"malformed","invalid_arguments"],[401,"unauthorized","unauthorized"],[404,"not_found","not_found"],[426,"unsupported_version","unsupported_version"],[500,"server_error","service_error"],[503,"server_error","service_error"]] as const) {
    reset(); double.state.forced = { status, body: { error: { code, message: "Synthetic private sentinel" } } };
    const answer = await readOwnerHistory({ action: "groups" }, ports);
    expect(answer).toMatchObject({ available: false, reason }); expect(JSON.stringify(answer)).not.toContain("sentinel");
  }
  reset(); double.state.forced = { status: 429, headers: { "Retry-After": "2" }, body: { error: { code: "rate_limited", message: "rate limited" } } };
  expect(await readOwnerHistory({ action: "groups" }, ports)).toMatchObject({ reason: "rate_limited", retryAfterSeconds: 2 });
  const before = double.state.requests; double.state.forced = null;
  expect(await readOwnerHistory({ action: "messages", chat: "-101" }, ports)).toMatchObject({ reason: "rate_limited" });
  expect(double.state.requests).toBe(before); now += 2000;
  expect(await readOwnerHistory({ action: "groups" }, ports)).toMatchObject({ available: true });
});
test("strict response schema and page byte cap fail closed", async () => {
  reset(); const base = await readOwnerGroupMessages(double.relay, "first", "-101", { tz: "Europe/Kyiv" });
  for (const body of [{ ...base, extra: true }, { ...base, next_cursor: 12 }, { ...base, messages: [{ ...base.messages[0], file_id: "synthetic" }] }, { ...base, title: "x".repeat(13000) }]) {
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
test("network loss and redirects return plain unreachable without a body", async () => {
  for (const forced of [{ drop: true }, { status: 302, headers: { Location: "https://elsewhere.example" }, body: { text: "Synthetic sentinel" } }]) {
    reset(); double.state.forced = forced;
    expect(await readOwnerHistory({ action: "groups" }, ports)).toMatchObject({ available: false, reason: "unreachable" });
  }
});
test("reads produce no log or stored content, including a successful page and a schema refusal", async () => {
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
    expect(logs).toEqual([]); expect(files(directory)).toEqual(before);
  } finally { for (const spy of spies) spy.mockRestore(); }
});

test("invalid JSON and an active trickle both stay bounded through real HTTP", async () => {
  const http = await import("node:http");
  let trickle = false;
  const server = http.createServer((req, res) => {
    req.socket.on("error", () => {});
    res.writeHead(200, { "content-type": "application/json" });
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
    trickle = true; const start = performance.now();
    expect(await readOwnerHistory({ action: "groups" }, isolated)).toMatchObject({ reason: "unreachable" });
    expect(performance.now() - start).toBeLessThan(4800);
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
