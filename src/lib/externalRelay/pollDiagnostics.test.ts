import { expect, spyOn, test } from "bun:test";
import { ExternalRelayError } from "./errors";
import { RelayPollDiagnostics, RELAY_POLL_SUMMARY_MS, relayPollFailure } from "./pollDiagnostics";

const start = Date.parse("2026-01-01T00:00:00Z");

test("outcome changes log once, while every outcome updates counters and time", () => {
  const log = spyOn(console, "info").mockImplementation(() => {});
  try {
    const diagnostics = new RelayPollDiagnostics(start);
    diagnostics.record({ outcome: "ok-empty", status: 204 }, start);
    diagnostics.record({ outcome: "ok-empty", status: 204 }, start + 1);
    diagnostics.record({ outcome: "claimed", status: 200 }, start + 2);
    diagnostics.record(relayPollFailure(new ExternalRelayError("untrusted", 503)), start + 3);
    diagnostics.record(relayPollFailure(new ExternalRelayError("untrusted", 503)), start + 4);
    diagnostics.record(relayPollFailure(new ExternalRelayError("untrusted", 429)), start + 5);
    expect(log).toHaveBeenCalledTimes(4);
    expect(diagnostics.snapshot()).toEqual({ path: "/requests/claim", since: new Date(start).toISOString(),
      lastOutcome: { outcome: "http:429", status: 429, reason: "other", at: new Date(start + 5).toISOString() },
      counters: { polls: 6, empty: 2, claimed: 1, errors: { "http:503": 2, "http:429": 1 } }, suppressedChanges: 0 });
    // Readers cannot mutate the owner's counters.
    diagnostics.snapshot().counters.errors["http:503"] = 0;
    expect(diagnostics.snapshot().counters.errors["http:503"]).toBe(2);
  } finally { log.mockRestore(); }
});

test("a sustained outage logs once plus one cumulative summary per ten minutes, including a parked loop", () => {
  const log = spyOn(console, "info").mockImplementation(() => {});
  try {
    const diagnostics = new RelayPollDiagnostics(start);
    for (let i = 0; i < 20; i++) diagnostics.record({ outcome: "connection:refused", status: null }, start + i * 30_000);
    expect(log).toHaveBeenCalledTimes(1);
    diagnostics.summarize(start + RELAY_POLL_SUMMARY_MS);
    diagnostics.summarize(start + RELAY_POLL_SUMMARY_MS + 1);
    expect(log).toHaveBeenCalledTimes(2);
    expect(JSON.parse(log.mock.calls[1]![1] as string)).toMatchObject({
      counters: { polls: 20, empty: 0, claimed: 0, errors: { "connection:refused": 20 } } });
    diagnostics.summarize(start + 2 * RELAY_POLL_SUMMARY_MS);
    expect(log).toHaveBeenCalledTimes(3);
  } finally { log.mockRestore(); }
});

test("flapping outcomes have a bounded journal rate and summaries expose suppressed changes", () => {
  const log = spyOn(console, "info").mockImplementation(() => {});
  try {
    const diagnostics = new RelayPollDiagnostics(start);
    for (let i = 0; i < 1000; i++) diagnostics.record({ outcome: i % 2 ? "ok-empty" : "claimed", status: 200 }, start + i);
    expect(log).toHaveBeenCalledTimes(30);
    expect(diagnostics.snapshot()).toMatchObject({ suppressedChanges: 970, counters: { polls: 1000, empty: 500, claimed: 500 } });
    diagnostics.record({ outcome: "connection:timeout", status: null }, start + 60_000);
    expect(log).toHaveBeenCalledTimes(31);
    diagnostics.summarize(start + RELAY_POLL_SUMMARY_MS);
    expect(JSON.parse(log.mock.calls[31]![1] as string).suppressedChanges).toBe(970);
  } finally { log.mockRestore(); }
});

for (const [code, outcome] of [
  ["ECONNREFUSED", "connection:refused"], ["ETIMEDOUT", "connection:timeout"],
  ["ENOTFOUND", "connection:dns"], ["EAI_AGAIN", "connection:dns"],
  ["CERT_HAS_EXPIRED", "connection:tls"], ["ERR_TLS_CERT_ALTNAME_INVALID", "connection:tls"],
  ["ECONNRESET", "connection:reset"], ["ENETUNREACH", "connection:unreachable"],
  ["untrusted-code", "local-error"],
] as const) test(`transport classification: ${code}`, () => {
  expect(relayPollFailure(Object.assign(new Error("private error detail"), { code }))).toEqual({ outcome, status: null });
});

test("remote codes, exception names, messages, payloads and causes never enter records or status", () => {
  const sentinel = "private transport detail";
  const log = spyOn(console, "info").mockImplementation(() => {});
  try {
    const diagnostics = new RelayPollDiagnostics(start);
    const errors = [new ExternalRelayError(sentinel, 502, null, { text: sentinel }),
      Object.assign(new Error(sentinel), { name: sentinel, code: sentinel, cause: sentinel }),
      new ExternalRelayError("dns_error"), new ExternalRelayError("timeout"),
      new ExternalRelayError("malformed", 200), new ExternalRelayError(sentinel, 999)];
    errors.forEach((error, i) => diagnostics.record(relayPollFailure(error), start + i));
    diagnostics.summarize(start + RELAY_POLL_SUMMARY_MS);
    expect(JSON.stringify([log.mock.calls, diagnostics.snapshot()])).not.toContain(sentinel);
    expect(relayPollFailure(new DOMException(sentinel, "TimeoutError"))).toEqual({ outcome: "connection:timeout", status: null });
    expect(relayPollFailure(new ExternalRelayError(sentinel), 503)).toEqual({ outcome: "http:503", status: 503, reason: "other" });
  } finally { log.mockRestore(); }
});


test("409 reason bodies survive the privacy boundary and reason changes are observable", () => {
  const log = spyOn(console, "info").mockImplementation(() => {});
  try {
    const diagnostics = new RelayPollDiagnostics(start);
    for (const code of ["lease_lost", "lease_lost", "already_completed", "private response detail"]) {
      diagnostics.record(relayPollFailure(new ExternalRelayError(code, 409, null, { error: { code } })), start);
    }
    expect(log).toHaveBeenCalledTimes(3);
    expect(JSON.parse(log.mock.calls[0]![1] as string)).toMatchObject({ status: 409, reason: "lease_lost" });
    expect(diagnostics.snapshot()).toMatchObject({ lastOutcome: { outcome: "http:409", status: 409, reason: "other" }, counters: { errors: { "http:409": 4 } } });
    expect(JSON.stringify(log.mock.calls)).not.toContain("private response detail");
  } finally { log.mockRestore(); }
});
