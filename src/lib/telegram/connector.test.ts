import { captureProcessIdentity, type ProcessIdentity } from "@/lib/processIdentity";
import { stopFixtureIdentity } from "@/lib/testing/fixtureProcess";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), "llv-telegram-connector-"));
const OLD_STATE = process.env.LLV_STATE_DIR;
const OLD_API_ID = process.env.LLV_TELEGRAM_API_ID;
const OLD_API_HASH = process.env.LLV_TELEGRAM_API_HASH;
process.env.LLV_STATE_DIR = path.join(SANDBOX, "state");
process.env.LLV_TELEGRAM_API_ID = "12345";
process.env.LLV_TELEGRAM_API_HASH = "0123456789abcdef0123456789abcdef";

const { TELEGRAM_CONNECTOR_LOG_MAX_BYTES, TELEGRAM_FEED_EXPOSED_TOOLS, TELEGRAM_READ_TOOL_ALLOWLIST, connectorFeedCoverageSince, connectorServerName, ensureTelegramConnector, stopTelegramConnector, stopTelegramConnectorForSession, telegramConnectorLogPath, verifyReadOnlyTools } = await import("./connector");
const { TELEGRAM_BURST_CONSUMING_TOOLS, telegramMcpUrl, vendoredConnectorDir } = await import("./packaging");

import type { ConnectorProbe, TelegramConnectorPorts } from "./connector";

/* A placeholder with the string-session shape; never a real credential. */
const PLACEHOLDER_SESSION = "1ApWapzMBu4placeholder-not-a-real-session";
const CONNECTOR_SESSION = {
  version: 1 as const,
  credentialRef: "credential-generation-a",
  connectorToken: "A".repeat(43),
  sessionString: PLACEHOLDER_SESSION,
  savedAt: "2026-08-20T12:00:00.000Z",
};

function READ_ONLY_FOR(connectorToken: string): ConnectorProbe {
  return { ok: true, serverName: connectorServerName(connectorToken), tools: [{ name: "get_me", readOnly: true }] };
}

const READ_ONLY: ConnectorProbe = {
  ok: true,
  serverName: connectorServerName(CONNECTOR_SESSION.connectorToken),
  tools: [
    { name: "get_me", readOnly: true },
    { name: "list_chats", readOnly: true },
  ],
};

/* `foreign` marks a recorded runner this Viewer process did not start: an
   earlier Viewer's, a previous service invocation's or an older release's. */
function fakePorts(script: Array<ConnectorProbe | null>, options: { spawnFails?: boolean; owned?: boolean; recordFails?: boolean; foreign?: boolean; admitted?: () => boolean } = {}) {
  const calls = { spawns: 0, probes: 0, stops: 0, records: 0, kills: [] as Array<NodeJS.Signals | undefined>, probeTokens: [] as string[] };
  const runner = { foreign: options.foreign ?? false };
  let clock = 0;
  let owned = options.owned ?? false;
  const ports: TelegramConnectorPorts = {
    spawn: () => {
      calls.spawns += 1;
      /* A real pid this test owns, so the /proc start-token fence records it. */
      return options.spawnFails ? null : { pid: process.pid, kill: (signal?: NodeJS.Signals) => { calls.kills.push(signal); return true; } };
    },
    probe: async (_url, connectorToken) => {
      calls.probes += 1;
      calls.probeTokens.push(connectorToken);
      return script.shift() ?? { ok: false };
    },
    sleep: async () => { clock += 10_000; },
    now: () => clock,
    ownsProcess: () => owned,
    stop: () => { calls.stops += 1; owned = false; },
    recordProcess: () => {
      calls.records += 1;
      if (options.recordFails) return false;
      owned = true;
      runner.foreign = false;
      return true;
    },
    ownGeneration: () => owned && !runner.foreign,
    admitted: options.admitted ?? (() => true),
  };
  return { ports, calls, runner };
}

beforeEach(async () => {
  await stopTelegramConnector();
  fs.rmSync(process.env.LLV_STATE_DIR!, { recursive: true, force: true });
  /* #1084: the connector runs from the provisioner's staged source copy;
     tests provide the directory the way a completed provision would. */
  fs.mkdirSync(path.join(process.env.LLV_STATE_DIR!, "telegram"), { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.join(process.env.LLV_STATE_DIR!, "telegram", "vendor-src"), { mode: 0o700 });
});
afterAll(() => {
  if (OLD_STATE === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = OLD_STATE;
  if (OLD_API_ID === undefined) delete process.env.LLV_TELEGRAM_API_ID; else process.env.LLV_TELEGRAM_API_ID = OLD_API_ID;
  if (OLD_API_HASH === undefined) delete process.env.LLV_TELEGRAM_API_HASH; else process.env.LLV_TELEGRAM_API_HASH = OLD_API_HASH;
  fs.rmSync(SANDBOX, { recursive: true, force: true });
});

test("every advertised tool must carry an affirmative readOnlyHint AND be on the audited allowlist", () => {
  expect(verifyReadOnlyTools([{ name: "get_me", readOnly: true }]).ok).toBe(true);
  const mixed = verifyReadOnlyTools([
    { name: "get_me", readOnly: true },
    { name: "send_message", readOnly: false },
  ]);
  expect(mixed.ok).toBe(false);
  expect(mixed.offending).toEqual(["send_message"]);
  /* The annotation alone is NOT sufficient: a tool CLAIMING readOnly whose
     name is outside the audited allowlist is refused — this is exactly the
     upstream get_invite_link failure (a read-annotated invite-link mint). */
  const claimed = verifyReadOnlyTools([
    { name: "get_me", readOnly: true },
    { name: "get_invite_link", readOnly: true },
  ]);
  expect(claimed.ok).toBe(false);
  expect(claimed.offending).toEqual(["get_invite_link"]);
  expect(verifyReadOnlyTools([{ name: "export_chat_invite", readOnly: true }]).ok).toBe(false);
  /* An empty tool list proves nothing and fails closed. */
  expect(verifyReadOnlyTools([]).ok).toBe(false);
});

test("a connector still advertising a burst consumer is refused, feed or no feed (#1091)", () => {
  /* The feed and `wait_for_settled_message` consume the SAME settled bursts —
     each pops the chat out of the connector's pending set, so whichever scans
     first takes it and the other never sees that dialog. Every connector the
     Viewer launches runs the feed, so a surface still advertising the consumer
     is one that would race the report's only evidence of an active dialog: it
     fails verification and is replaced, rather than being trusted. */
  expect([...TELEGRAM_BURST_CONSUMING_TOOLS]).toEqual(["wait_for_settled_message"]);
  const racing = verifyReadOnlyTools([
    { name: "get_me", readOnly: true },
    { name: "wait_for_settled_message", readOnly: true },
  ]);
  expect(racing.ok).toBe(false);
  expect(racing.offending).toEqual(["wait_for_settled_message"]);
  /* The withholding is scoped to the consumers and nothing else:
     `wait_for_new_message` reports the pending set without removing anything,
     so it takes no burst from the feed and stays exposed. */
  expect(verifyReadOnlyTools([{ name: "wait_for_new_message", readOnly: true }]).ok).toBe(true);
  /* The AUDITED surface is unchanged — the consumer writes nothing, and a
     connector with no feed to starve may expose it. Only exposure narrows. */
  expect(TELEGRAM_READ_TOOL_ALLOWLIST.has("wait_for_settled_message")).toBe(true);
  expect(verifyReadOnlyTools(
    [{ name: "wait_for_settled_message", readOnly: true }],
    TELEGRAM_READ_TOOL_ALLOWLIST,
  ).ok).toBe(true);
  expect([...TELEGRAM_FEED_EXPOSED_TOOLS].sort()).toEqual(
    [...TELEGRAM_READ_TOOL_ALLOWLIST].filter((name) => name !== "wait_for_settled_message").sort(),
  );
});

test("the allowlist equals the vendored registry's read-only surface, minus nothing", () => {
  /* Re-derive the read-annotated tool set from the ACTUAL vendored source, so
     a vendor bump that adds or re-annotates a tool cannot silently diverge
     from the audited allowlist — parity failure forces a fresh audit. */
  const toolsDir = path.join(vendoredConnectorDir(), "telegram_mcp", "tools");
  const registry = new Set<string>();
  for (const file of fs.readdirSync(toolsDir).filter((name) => name.endsWith(".py"))) {
    const text = fs.readFileSync(path.join(toolsDir, file), "utf8");
    for (const chunk of text.split(/(?=@mcp\.tool\()/)) {
      const head = chunk.split("async def")[0]!;
      if (!head.includes("readOnlyHint=True")) continue;
      const name = chunk.match(/async def (\w+)\(/)?.[1];
      if (name) registry.add(name);
    }
  }
  expect([...registry].sort()).toEqual([...TELEGRAM_READ_TOOL_ALLOWLIST].sort());
  /* The two disproven upstream annotations stay patched off the read surface
     (vendor/telegram-mcp/PROVENANCE.md) and off the allowlist. */
  for (const disproven of ["get_invite_link", "export_chat_invite"]) {
    expect(registry.has(disproven)).toBe(false);
    expect(TELEGRAM_READ_TOOL_ALLOWLIST.has(disproven)).toBe(false);
  }
  /* The withheld set is derived from what the vendored implementations DO with
     a settled burst, not from their names (#1091): a consumer pops the chat
     out of the pending set the feed reads. A vendor bump that makes another
     tool pop — or that stops the withheld one from popping — fails here rather
     than silently reopening (or pointlessly keeping) the race. */
  const events = fs.readFileSync(path.join(toolsDir, "events.py"), "utf8");
  const bodyOf = (name: string): string => events.split(`async def ${name}(`)[1]!.split("@mcp.tool(")[0]!;
  for (const consumer of TELEGRAM_BURST_CONSUMING_TOOLS) {
    expect(registry.has(consumer)).toBe(true);
    expect(bodyOf(consumer)).toContain("_pending_msgs.pop");
  }
  expect(bodyOf("wait_for_new_message")).not.toContain("_pending_msgs.pop");
});

test("an already-listening read-only connector is adopted, never duplicated", async () => {
  const { ports, calls } = fakePorts([READ_ONLY], { owned: true });
  const result = await ensureTelegramConnector(CONNECTOR_SESSION, ports);
  expect(result).toEqual({ ok: true, url: telegramMcpUrl() });
  expect(calls.spawns).toBe(0);
  expect(calls.probeTokens).toEqual([CONNECTOR_SESSION.connectorToken]);
});

test("a failed probe stops only the connector owned by its credential generation", async () => {
  const current = fakePorts([], { owned: true });
  expect(await stopTelegramConnectorForSession(CONNECTOR_SESSION, current.ports)).toBe(true);
  expect(current.calls.stops).toBe(1);

  const stale = fakePorts([], { owned: false });
  expect(await stopTelegramConnectorForSession(CONNECTOR_SESSION, stale.ports)).toBe(false);
  expect(stale.calls.stops).toBe(0);
});

test("spawns once, waits for readiness, and records the winner before probing", async () => {
  const { ports, calls } = fakePorts([null, null, READ_ONLY]);
  const result = await ensureTelegramConnector(CONNECTOR_SESSION, ports);
  expect(result.ok).toBe(true);
  expect(calls.spawns).toBe(1);
  expect(calls.records).toBe(1);
  expect(calls.probes).toBe(3);
});

test("the detached connector keeps its owner-only log bounded after the Viewer launcher exits", async () => {
  const python = Bun.which("python3");
  expect(python).not.toBeNull();
  const doneFile = path.join(SANDBOX, "bounded-log-done");
  const fakeConnector = path.join(SANDBOX, "bounded-log-connector.py");
  const launcher = path.join(SANDBOX, "detached-connector-launcher.mjs");
  const launchSpecFile = path.join(SANDBOX, "detached-connector-launch.json");
  fs.writeFileSync(fakeConnector, [
    "import sys",
    `done_file = ${JSON.stringify(doneFile)}`,
    `for _ in range(${Math.ceil(TELEGRAM_CONNECTOR_LOG_MAX_BYTES * 2 / 8_192)}):`,
    "    sys.stdout.write('x' * 8192)",
    "    sys.stdout.flush()",
    "sys.stderr.write('bounded tail marker\\n')",
    "sys.stderr.flush()",
    "with open(done_file, 'w', encoding='utf-8') as handle:",
    "    handle.write('done')",
    "",
  ].join("\n"), { mode: 0o600 });
  fs.writeFileSync(launcher, [
    "import fs from 'node:fs';",
    "import { spawn } from 'node:child_process';",
    "const input = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));",
    "const logFd = fs.openSync(input.logPath, 'a', 0o600);",
    "const child = spawn(input.command, input.args, { cwd: input.cwd, env: input.env, stdio: ['ignore', logFd, logFd], detached: true });",
    "child.unref();",
    "fs.closeSync(logFd);",
    "",
  ].join("\n"), { mode: 0o600 });

  const oldPython = process.env.LLV_TELEGRAM_PYTHON;
  const oldBridge = process.env.LLV_TELEGRAM_SERVER_BRIDGE;
  process.env.LLV_TELEGRAM_PYTHON = python!;
  process.env.LLV_TELEGRAM_SERVER_BRIDGE = fakeConnector;
  try {
    const { connectorLaunchSpec } = await import("./packaging");
    const spec = connectorLaunchSpec({
      credentialRef: CONNECTOR_SESSION.credentialRef,
      sessionString: PLACEHOLDER_SESSION,
      connectorToken: CONNECTOR_SESSION.connectorToken,
      credentials: { apiId: "12345", apiHash: "0123456789abcdef0123456789abcdef" },
    });
    fs.writeFileSync(launchSpecFile, JSON.stringify({ ...spec, logPath: telegramConnectorLogPath() }), { mode: 0o600 });
    const launched = spawn(process.execPath, [launcher, launchSpecFile], { stdio: "ignore" });
    expect(await new Promise<number | null>((resolve) => launched.once("exit", resolve))).toBe(0);

    const deadline = Date.now() + 5_000;
    while (!fs.existsSync(doneFile) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    expect(fs.existsSync(doneFile)).toBe(true);
    const stat = fs.statSync(telegramConnectorLogPath());
    expect(stat.size).toBeLessThanOrEqual(TELEGRAM_CONNECTOR_LOG_MAX_BYTES);
    expect(stat.mode & 0o077).toBe(0);
    expect(fs.readFileSync(telegramConnectorLogPath(), "utf8")).toEndWith("bounded tail marker\n");
  } finally {
    if (oldPython === undefined) delete process.env.LLV_TELEGRAM_PYTHON;
    else process.env.LLV_TELEGRAM_PYTHON = oldPython;
    if (oldBridge === undefined) delete process.env.LLV_TELEGRAM_SERVER_BRIDGE;
    else process.env.LLV_TELEGRAM_SERVER_BRIDGE = oldBridge;
  }
}, 10_000);

test("a connector advertising a non-read-only tool is refused", async () => {
  const withWrite: ConnectorProbe = {
    ok: true,
    serverName: connectorServerName(CONNECTOR_SESSION.connectorToken),
    tools: [{ name: "get_me", readOnly: true }, { name: "send_message", readOnly: false }],
  };
  const { ports, calls } = fakePorts([null, withWrite]);
  const result = await ensureTelegramConnector(CONNECTOR_SESSION, ports);
  expect(result).toEqual({ ok: false, code: "not_read_only" });
  expect(calls.spawns).toBe(1);
});

test("a connector that never becomes ready reports connector_failed", async () => {
  const { ports } = fakePorts([]);
  const result = await ensureTelegramConnector(CONNECTOR_SESSION, ports);
  expect(result).toEqual({ ok: false, code: "connector_failed" });
});

test("a spawn failure reports connector_failed without probing forever", async () => {
  const { ports } = fakePorts([null], { spawnFails: true });
  const result = await ensureTelegramConnector(CONNECTOR_SESSION, ports);
  expect(result).toEqual({ ok: false, code: "connector_failed" });
});

test("the launch env — not this test's env — carries the session; argv never does", async () => {
  const { connectorLaunchSpec } = await import("./packaging");
  const spec = connectorLaunchSpec({
    credentialRef: CONNECTOR_SESSION.credentialRef,
    sessionString: PLACEHOLDER_SESSION,
    connectorToken: CONNECTOR_SESSION.connectorToken,
    credentials: { apiId: "12345", apiHash: "0123456789abcdef0123456789abcdef" },
  });
  expect(spec.args.join(" ")).not.toContain(PLACEHOLDER_SESSION);
  expect(spec.args.join(" ")).not.toContain(CONNECTOR_SESSION.connectorToken);
  expect(spec.env.TELEGRAM_SESSION_STRING).toBe(PLACEHOLDER_SESSION);
  expect(spec.env.TELEGRAM_EXPOSED_TOOLS).toBe("read-only");
  expect(spec.env.MCP_TRANSPORT).toBe("http");
  expect(spec.env.MCP_HOST).toBe("127.0.0.1");
  expect(spec.env.LLV_TELEGRAM_MCP_TOKEN).toBe(CONNECTOR_SESSION.connectorToken);
  expect(spec.args).toEqual([expect.stringContaining("telegram-mcp-server.py")]);
});

test("the connector runs its incoming feed, beside the credential (#1091)", async () => {
  const { connectorLaunchSpec } = await import("./packaging");
  const { telegramIncomingFeedPath } = await import("./sessionStore");
  const launch = (credentialRef: string) => connectorLaunchSpec({
    credentialRef,
    sessionString: PLACEHOLDER_SESSION,
    connectorToken: CONNECTOR_SESSION.connectorToken,
    credentials: { apiId: "12345", apiHash: "0123456789abcdef0123456789abcdef" },
  });
  const spec = launch(CONNECTOR_SESSION.credentialRef);
  /* Without this the connector records activity nowhere and a report's
     private-dialog discovery is back to guessing from a chat list that is not
     ordered by recency. */
  expect(spec.env.TELEGRAM_EVENT_FEED).toBe("1");
  /* The feed names the operator's correspondents, so it lives inside the 0700
     telegram directory rather than at the connector's XDG default. */
  expect(spec.env.TELEGRAM_EVENT_FEED_FILE).toBe(telegramIncomingFeedPath(CONNECTOR_SESSION.credentialRef));
  /* Named for the credential GENERATION, and by a digest of it rather than
     the ref itself, so no value read from disk is ever spliced into a path. */
  expect(path.dirname(spec.env.TELEGRAM_EVENT_FEED_FILE!)).toBe(path.join(process.env.LLV_STATE_DIR!, "telegram"));
  expect(path.basename(spec.env.TELEGRAM_EVENT_FEED_FILE!)).toMatch(/^incoming_feed-[0-9a-f]{16}\.jsonl$/);
  expect(spec.env.TELEGRAM_EVENT_FEED_FILE).not.toContain(CONNECTOR_SESSION.credentialRef);
  /* A second account's connector writes a different file, so nothing it
     records can be read as the first account's activity (#1091). */
  expect(launch("credential-generation-b").env.TELEGRAM_EVENT_FEED_FILE).not.toBe(spec.env.TELEGRAM_EVENT_FEED_FILE);
  /* Turning the feed on is half of it: the tools that would pop the same
     bursts are withheld in the same breath, so the feed is the only consumer
     left. The entrypoint reads this list; `TELEGRAM_EXPOSED_TOOLS` cannot
     express it, because upstream's read-only mode only ever WIDENS. */
  expect(spec.env.LLV_TELEGRAM_EXCLUDED_TOOLS).toBe("wait_for_settled_message");
  expect(spec.env.LLV_TELEGRAM_EXCLUDED_TOOLS!.split(",")).toEqual([...TELEGRAM_BURST_CONSUMING_TOOLS]);
});

test("an allowlisted foreign listener is never adopted", async () => {
  const foreign: ConnectorProbe = { ...READ_ONLY, serverName: "telegram" };
  const { ports, calls } = fakePorts([foreign]);
  const result = await ensureTelegramConnector(CONNECTOR_SESSION, ports);
  expect(result).toEqual({ ok: false, code: "connector_failed" });
  expect(calls.spawns).toBe(1);
  expect(calls.stops).toBeGreaterThanOrEqual(2);
});

test("a healthy current-generation connector is preserved when launch metadata is missing", async () => {
  /* A connector spawned by an older Viewer can lack feed/log metadata while
     still proving the current credential and read-only MCP surface. Fresh
     health must keep that healthy process; a later allowed replacement will
     add the newer launch guarantees. */
  const { ports, calls } = fakePorts([READ_ONLY], { owned: true });

  const result = await ensureTelegramConnector(CONNECTOR_SESSION, ports);

  expect(result).toEqual({ ok: true, url: telegramMcpUrl() });
  expect(calls.spawns).toBe(0);
  expect(calls.stops).toBe(0);
  expect(calls.records).toBe(0);
  expect(calls.probes).toBe(1);
});

/** A connector record of the shape the supervisor writes, so the real feed
    coverage check has something to read. Nothing here is a live process. */
async function writeConnectorRecord(feedFile: string, feedSince?: string, hasBoundedLog = true): Promise<void> {
  fs.writeFileSync(
    path.join(process.env.LLV_STATE_DIR!, "telegram", "connector.json"),
    JSON.stringify({
      version: 1,
      pid: process.pid,
      identity: "start-token-placeholder",
      credentialRef: CONNECTOR_SESSION.credentialRef,
      connectorTokenSha256: "f".repeat(64),
      command: (await import("./packaging")).telegramVenvPython(),
      entrypoint: (await import("./packaging")).telegramMcpServerPath(),
      feedFile,
      ...(feedSince ? { feedSince } : {}),
      ...(hasBoundedLog ? { logSinkVersion: 1 } : {}),
    }),
    { mode: 0o600 },
  );
}

test("the record says since when this generation's feed can be believed (#1091)", async () => {
  /* A report asks the feed for the dialogs active since the last run, and the
     feed can only answer for the time it was listening — which the file itself
     cannot say and `incoming_feed_status` does not report. The record written
     at spawn is the evidence, and it is scoped to the credential generation
     for the same reason the feed file is: another account's listener says
     nothing about this one's window. */
  const { telegramIncomingFeedPath } = await import("./sessionStore");
  const startedAt = "2026-08-21T04:00:00.000Z";

  await writeConnectorRecord(telegramIncomingFeedPath(CONNECTOR_SESSION.credentialRef), startedAt);
  expect(connectorFeedCoverageSince(CONNECTOR_SESSION.credentialRef)).toBe(Date.parse(startedAt));

  /* Another generation's listener: no coverage of THIS account's window. */
  expect(connectorFeedCoverageSince("credential-generation-of-another-account")).toBeNull();

  /* A feed with no start stamp vouches for nothing rather than for
     everything — the caller treats unknown coverage as uncovered. */
  await writeConnectorRecord(telegramIncomingFeedPath(CONNECTOR_SESSION.credentialRef));
  expect(connectorFeedCoverageSince(CONNECTOR_SESSION.credentialRef)).toBeNull();

  fs.rmSync(path.join(process.env.LLV_STATE_DIR!, "telegram", "connector.json"), { force: true });
  expect(connectorFeedCoverageSince(CONNECTOR_SESSION.credentialRef)).toBeNull();
});

test("a feed metadata mismatch does not restart a healthy current-generation connector", async () => {
  const { telegramIncomingFeedPath } = await import("./sessionStore");
  /* The mismatched record cannot vouch for this generation's feed coverage,
     though process ownership plus a successful probe still prove the healthy
     connector itself. */
  await writeConnectorRecord(telegramIncomingFeedPath("credential-generation-of-another-account"));
  const stale = fakePorts([READ_ONLY], { owned: true });

  const adoptedWithoutCoverage = await ensureTelegramConnector(CONNECTOR_SESSION, stale.ports);

  expect(adoptedWithoutCoverage).toEqual({ ok: true, url: telegramMcpUrl() });
  expect(stale.calls.spawns).toBe(0);
  expect(stale.calls.stops).toBe(0);

  /* Matching metadata preserves the same healthy-process behavior. */
  await writeConnectorRecord(telegramIncomingFeedPath(CONNECTOR_SESSION.credentialRef));
  const current = fakePorts([READ_ONLY], { owned: true });

  const adopted = await ensureTelegramConnector(CONNECTOR_SESSION, current.ports);

  expect(adopted).toEqual({ ok: true, url: telegramMcpUrl() });
  expect(current.calls.spawns).toBe(0);
});

test("fresh health preserves a healthy connector recorded before process-owned log bounds", async () => {
  const { telegramIncomingFeedPath } = await import("./sessionStore");
  await writeConnectorRecord(
    telegramIncomingFeedPath(CONNECTOR_SESSION.credentialRef),
    undefined,
    false,
  );
  const viewer = fakePorts([READ_ONLY], { owned: true });

  const result = await ensureTelegramConnector(CONNECTOR_SESSION, viewer.ports);

  expect(result).toEqual({ ok: true, url: telegramMcpUrl() });
  expect(viewer.calls.stops).toBe(0);
  expect(viewer.calls.spawns).toBe(0);
  expect(viewer.calls.probes).toBe(1);
});

test("a credential-generation mismatch stops the old record before spawning", async () => {
  const { ports, calls } = fakePorts([READ_ONLY], { owned: false });
  const result = await ensureTelegramConnector(CONNECTOR_SESSION, ports);
  expect(result.ok).toBe(true);
  expect(calls.stops).toBeGreaterThanOrEqual(1);
  expect(calls.spawns).toBe(1);
});

test("concurrent Viewer generations serialize adoption and spawn one recorded connector", async () => {
  let owned = false;
  let spawns = 0;
  let records = 0;
  const ports: TelegramConnectorPorts = {
    ownsProcess: () => owned,
    ownGeneration: () => owned,
    stop: async () => { await Promise.resolve(); owned = false; },
    spawn: () => {
      spawns += 1;
      return { pid: process.pid, kill: () => true };
    },
    recordProcess: () => {
      records += 1;
      owned = true;
      return true;
    },
    probe: async () => READ_ONLY,
    sleep: async () => {},
    now: () => Date.now(),
  };

  const [first, second] = await Promise.all([
    ensureTelegramConnector(CONNECTOR_SESSION, ports),
    ensureTelegramConnector(CONNECTOR_SESSION, ports),
  ]);

  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  expect(spawns).toBe(1);
  expect(records).toBe(1);
});

test("an older failed readiness probe cannot stop a newer credential generation", async () => {
  const newerSession = {
    ...CONNECTOR_SESSION,
    credentialRef: "credential-generation-b",
    connectorToken: "B".repeat(43),
  };
  let binding: { credentialRef: string; connectorToken: string } | null = null;
  let spawns = 0;
  let stops = 0;
  let clock = 0;
  let firstProbeStarted!: () => void;
  const firstStarted = new Promise<void>((resolve) => { firstProbeStarted = resolve; });
  let resolveFirstProbe!: (probe: ConnectorProbe) => void;
  const firstProbe = new Promise<ConnectorProbe>((resolve) => { resolveFirstProbe = resolve; });
  const ports: TelegramConnectorPorts = {
    ownsProcess: (candidate) => binding?.credentialRef === candidate.credentialRef
      && binding.connectorToken === candidate.connectorToken,
    stop: () => { stops += 1; binding = null; },
    spawn: () => { spawns += 1; return { pid: process.pid, kill: () => true }; },
    recordProcess: (_child, _spec, candidate) => { binding = { ...candidate }; return true; },
    probe: async (_url, token) => {
      if (token === CONNECTOR_SESSION.connectorToken) {
        firstProbeStarted();
        return await firstProbe;
      }
      return {
        ok: true,
        serverName: connectorServerName(token),
        tools: [{ name: "get_me", readOnly: true }],
      };
    },
    sleep: async () => { clock += 30_001; },
    now: () => clock,
  };

  const older = ensureTelegramConnector(CONNECTOR_SESSION, ports);
  await firstStarted;
  const newer = await ensureTelegramConnector(newerSession, ports);
  expect(newer.ok).toBe(true);
  expect((binding as { credentialRef: string; connectorToken: string } | null)?.credentialRef).toBe(newerSession.credentialRef);

  resolveFirstProbe({ ok: false });
  expect(await older).toEqual({ ok: false, code: "connector_failed" });
  expect((binding as { credentialRef: string; connectorToken: string } | null)?.credentialRef).toBe(newerSession.credentialRef);
  expect(spawns).toBe(2);
  expect(stops).toBe(2);
});

test("failed durable recording kills the live child before any probe", async () => {
  const { ports, calls } = fakePorts([READ_ONLY], { recordFails: true });
  const result = await ensureTelegramConnector(CONNECTOR_SESSION, ports);
  expect(result).toEqual({ ok: false, code: "connector_failed" });
  expect(calls.probes).toBe(0);
  expect(calls.kills).toContain("SIGKILL");
});

test("stop invalidates an in-flight connector operation", async () => {
  let generation = 0;
  let resolveProbe!: (probe: ConnectorProbe) => void;
  const probe = new Promise<ConnectorProbe>((resolve) => { resolveProbe = resolve; });
  let spawns = 0;
  const ports: TelegramConnectorPorts = {
    spawn: () => { spawns += 1; return null; },
    probe: async () => await probe,
    sleep: async () => {},
    now: () => 0,
    ownsProcess: () => true,
    ownGeneration: () => true,
    beginOperation: () => {
      const current = ++generation;
      return () => current === generation;
    },
    stop: () => { generation += 1; },
  };

  const pending = ensureTelegramConnector(CONNECTOR_SESSION, ports);
  ports.stop!();
  resolveProbe(READ_ONLY);
  expect(await pending).toEqual({ ok: false, code: "connector_failed" });
  expect(spawns).toBe(0);
});

test("a stalled readiness probe is bounded and terminates the spawned child", async () => {
  const kills: Array<NodeJS.Signals | undefined> = [];
  let probeSignal: AbortSignal | undefined;
  let owned = false;
  const child = { pid: process.pid, kill: (signal?: NodeJS.Signals) => { kills.push(signal); return true; } };
  const ports: TelegramConnectorPorts = {
    spawn: () => child,
    probe: async (_url, _token, signal) => {
      probeSignal = signal;
      return await new Promise<ConnectorProbe>(() => {});
    },
    sleep: async () => {},
    now: () => 0,
    ownsProcess: () => owned,
    recordProcess: () => { owned = true; return true; },
    stop: () => { owned = false; child.kill("SIGTERM"); },
    probeTimeoutMs: 10,
  };

  expect(await ensureTelegramConnector(CONNECTOR_SESSION, ports)).toEqual({ ok: false, code: "connector_failed" });
  expect(probeSignal?.aborted).toBe(true);
  expect(kills).toContain("SIGTERM");
}, 1_000);

test("stop waits through SIGKILL escalation until a TERM-resistant connector exits", async () => {
  const script = path.join(SANDBOX, "term-resistant-connector.mjs");
  const readyFile = path.join(SANDBOX, "term-resistant-ready");
  fs.writeFileSync(script, [
    "import fs from 'node:fs';",
    `fs.writeFileSync(${JSON.stringify(readyFile)}, 'ready');`,
    "process.on('SIGTERM', () => undefined);",
    "setInterval(() => undefined, 1000);",
    "",
  ].join("\n"));
  process.env.LLV_TELEGRAM_PYTHON = process.execPath;
  process.env.LLV_TELEGRAM_SERVER_BRIDGE = script;
  let childPid = 0;
  let childIdentity: ProcessIdentity | undefined;
  try {
    const result = await ensureTelegramConnector(CONNECTOR_SESSION, {
      spawn: (spec) => {
        const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: spec.env, stdio: "ignore" });
        childPid = child.pid ?? 0;
        if (childPid > 0) childIdentity = captureProcessIdentity(childPid);
        return child;
      },
      probe: async () => {
        while (!fs.existsSync(readyFile)) await new Promise((resolve) => setTimeout(resolve, 5));
        return READ_ONLY;
      },
      sleep: async () => {},
      now: () => Date.now(),
      ownsProcess: () => false,
    });
    expect(result.ok).toBe(true);
    expect(childPid).toBeGreaterThan(1);
    const pidFile = path.join(process.env.LLV_STATE_DIR!, "telegram", "connector.json");
    const recorded = JSON.parse(fs.readFileSync(pidFile, "utf8")) as {
      pid: number; identity: string; credentialRef: string; connectorTokenSha256: string; feedFile?: string; feedSince?: string; logSinkVersion?: number;
    };
    expect(recorded.pid).toBe(childPid);
    expect(recorded.credentialRef).toBe(CONNECTOR_SESSION.credentialRef);
    /* The feed is child ENVIRONMENT, so the record is the only durable proof
       that this process runs one — and it is what a later Viewer generation
       checks before adopting it (#1091). */
    const { telegramIncomingFeedPath } = await import("./sessionStore");
    expect(recorded.feedFile).toBe(telegramIncomingFeedPath(CONNECTOR_SESSION.credentialRef));
    /* Recorded together with it: the instant this listener started, which is
       the earliest moment its feed can vouch for a report's window (#1091). */
    expect(Date.parse(recorded.feedSince!)).toBeLessThanOrEqual(Date.now());
    expect(connectorFeedCoverageSince(CONNECTOR_SESSION.credentialRef)).toBe(Date.parse(recorded.feedSince!));
    expect(recorded.connectorTokenSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(recorded.logSinkVersion).toBe(1);
    expect(fs.readFileSync(pidFile, "utf8")).not.toContain(CONNECTOR_SESSION.connectorToken);

    await stopTelegramConnector();
    expect(() => process.kill(childPid, 0)).toThrow();
    expect(fs.existsSync(pidFile)).toBe(false);
  } finally {
    delete process.env.LLV_TELEGRAM_PYTHON;
    delete process.env.LLV_TELEGRAM_SERVER_BRIDGE;
    if (childIdentity) await stopFixtureIdentity(childIdentity);
  }
}, 5_000);

/* ── A connector that outlived the Viewer that started it ───────────────────── */

/* 2026-10-10: a healthy runner a Viewer of an earlier release had started was
   adopted by every Viewer after it, survived each service restart, and kept
   the service's old cgroup populated, so the service never reached its
   configured slice. The Viewer that owns traffic replaces such a runner. */
for (const [name, releases] of [
  ["an older release", ["release-a", "release-b"]],
  ["this release under an earlier service invocation", ["release-c", "release-c"]],
] as const) test(`the Viewer that takes over replaces a healthy connector started from ${name}`, async () => {
  const { asRelease, endConnectorProcess, releaseTakeover, startConnectorFromRelease } = await import("./fixtures/releaseConnector");
  const { readTelegramLaunchState } = await import("./launchReadiness");
  const { readTelegramConnection, saveTelegramSession, writeTelegramConnection } = await import("./sessionStore");
  const session = saveTelegramSession(PLACEHOLDER_SESSION);
  writeTelegramConnection({ version: 1, status: "error", credentialRef: session.credentialRef, identity: null,
    lastHealthCheckAt: null, errorCode: "bridge_failed", identityIdUpgradedAt: null });
  const earlier = startConnectorFromRelease(path.join(SANDBOX, releases[0]));
  let started: number[] = [];
  try {
    await asRelease(path.join(SANDBOX, releases[1]), async () => {
      expect(readTelegramLaunchState()).toEqual({ kind: "recoverable" });
      const { service, calls } = releaseTakeover(session.connectorToken);
      started = calls.pids;
      await service.checkHealth();
      expect(readTelegramConnection().status).toBe("connected");
      expect(readTelegramLaunchState()).toEqual({ kind: "ready", token: session.connectorToken });
      /* One connector: the one this Viewer started, and the earlier one gone. */
      expect(calls.spawns).toBe(1);
      expect(() => process.kill(earlier.pid, 0)).toThrow();
      const recorded = JSON.parse(fs.readFileSync(path.join(process.env.LLV_STATE_DIR!, "telegram", "connector.json"), "utf8")) as { pid: number; entrypoint: string; ownerPid: number; lease: string };
      expect(recorded.pid).toBe(calls.pids[0]!);
      expect(recorded.entrypoint).toBe(path.join(SANDBOX, releases[1], "bin", "telegram-mcp-server.py"));
      expect(recorded.ownerPid).toBe(process.pid);
      expect(recorded.lease).toBe("stdin");
      /* Its own runner is adopted on the next check, not replaced again. */
      await service.checkHealth();
      expect(calls.spawns).toBe(1);
      await stopTelegramConnector();
      expect(() => process.kill(calls.pids[0]!, 0)).toThrow();
    });
  } finally {
    endConnectorProcess(earlier.pid);
    for (const pid of started) endConnectorProcess(pid);
  }
}, 20_000);

test("a Viewer that no longer owns traffic neither replaces nor signals the recorded connector", async () => {
  const healthy = fakePorts([READ_ONLY], { owned: true, foreign: true, admitted: () => false });
  expect(await ensureTelegramConnector(CONNECTOR_SESSION, healthy.ports)).toEqual({ ok: true, url: telegramMcpUrl() });
  expect(healthy.calls.spawns).toBe(0);
  expect(healthy.calls.stops).toBe(0);

  const silent = fakePorts([null], { owned: true, foreign: true, admitted: () => false });
  expect(await ensureTelegramConnector(CONNECTOR_SESSION, silent.ports)).toEqual({ ok: false, code: "connector_failed" });
  expect(silent.calls.spawns).toBe(0);
  expect(silent.calls.stops).toBe(0);

  const nothing = fakePorts([], { admitted: () => false });
  expect(await ensureTelegramConnector(CONNECTOR_SESSION, nothing.ports)).toEqual({ ok: false, code: "connector_failed" });
  expect(nothing.calls.spawns).toBe(0);
  expect(nothing.calls.stops).toBe(0);
});

test("a Viewer retired while it stops the old connector starts no new one", async () => {
  let retired = false;
  const { ports, calls } = fakePorts([READ_ONLY], { owned: true, foreign: true, admitted: () => !retired });
  const stop = ports.stop!;
  ports.stop = () => { retired = true; return stop(); };
  expect(await ensureTelegramConnector(CONNECTOR_SESSION, ports)).toEqual({ ok: false, code: "connector_failed" });
  expect(calls.stops).toBe(1);
  expect(calls.spawns).toBe(0);
});

test("a predecessor whose connector never became ready leaves its successor's connector running", async () => {
  const { ports, calls, runner } = fakePorts([]);
  const record = ports.recordProcess!;
  /* The successor records its own runner for the same credential while this
     Viewer still waits for readiness. */
  ports.recordProcess = (...args) => {
    const recorded = record(...args);
    runner.foreign = true;
    return recorded;
  };
  expect(await ensureTelegramConnector(CONNECTOR_SESSION, ports)).toEqual({ ok: false, code: "connector_failed" });
  expect(calls.spawns).toBe(1);
  /* The one stop before the spawn, and none at the readiness deadline. */
  expect(calls.stops).toBe(1);
});

test("retirement ends the runner this Viewer started and leaves one it did not start", async () => {
  const { asRelease, endConnectorProcess, startConnectorFromRelease } = await import("./fixtures/releaseConnector");
  const { retireTelegramConnectorSupervisor, spawnTelegramConnectorProcess } = await import("./connector");
  const { saveTelegramSession } = await import("./sessionStore");
  const session = saveTelegramSession(PLACEHOLDER_SESSION);
  const retired = Symbol.for("delegatus.telegramConnector.retired");
  const pids: number[] = [];
  const probe = async () => READ_ONLY_FOR(session.connectorToken);
  try {
    await asRelease(path.join(SANDBOX, "release-d"), async () => {
      const ports: TelegramConnectorPorts = {
        spawn: (spec) => { const child = spawnTelegramConnectorProcess(spec); if (child?.pid) pids.push(child.pid); return child; },
        probe, sleep: async () => {}, now: () => Date.now(),
      };
      expect((await ensureTelegramConnector(session, ports)).ok).toBe(true);
      await retireTelegramConnectorSupervisor();
      expect(() => process.kill(pids[0]!, 0)).toThrow();
      /* Admission stays closed: no later check starts another. */
      expect(await ensureTelegramConnector(session, ports)).toEqual({ ok: false, code: "connector_failed" });
      expect(pids).toHaveLength(1);
    });
    delete (globalThis as Record<symbol, unknown>)[retired];
    const earlier = startConnectorFromRelease(path.join(SANDBOX, "release-e"));
    pids.push(earlier.pid);
    await retireTelegramConnectorSupervisor();
    expect(() => process.kill(earlier.pid, 0)).not.toThrow();
    /* Nor does a retired Viewer's public stop reach it. */
    expect(await stopTelegramConnector()).toBe(false);
    expect(() => process.kill(earlier.pid, 0)).not.toThrow();
    delete (globalThis as Record<symbol, unknown>)[retired];
    await asRelease(path.join(SANDBOX, "release-e"), () => stopTelegramConnector());
  } finally {
    delete (globalThis as Record<symbol, unknown>)[retired];
    for (const pid of pids) endConnectorProcess(pid);
  }
}, 20_000);

test("a health check begun before the handover leaves the successor's connector running when it finishes after it", async () => {
  const { asRelease, endConnectorProcess, releaseTakeover, startConnectorFromReleaseBeside } = await import("./fixtures/releaseConnector");
  const { saveTelegramSession, writeTelegramConnection } = await import("./sessionStore");
  const session = saveTelegramSession(PLACEHOLDER_SESSION);
  writeTelegramConnection({ version: 1, status: "error", credentialRef: session.credentialRef, identity: null,
    lastHealthCheckAt: null, errorCode: "bridge_failed", identityIdUpgradedAt: null });
  const target = path.join(process.env.LLV_STATE_DIR!, "viewer-release.json");
  const recordFile = path.join(process.env.LLV_STATE_DIR!, "telegram", "connector.json");
  const oldPort = process.env.PORT;
  const pids: number[] = [];
  let successor: { pid: number } | null = null;
  try {
    /* This test process is the predecessor Viewer, serving on 4001. */
    process.env.PORT = "4001";
    fs.writeFileSync(target, JSON.stringify({ endpoint: "http://127.0.0.1:4001" }));
    await asRelease(path.join(SANDBOX, "release-f"), async () => {
      let identityAsked!: () => void;
      const asked = new Promise<void>((resolve) => { identityAsked = resolve; });
      let answerIdentity!: (identity: null) => void;
      const stops: number[] = [];
      const takeover = releaseTakeover(session.connectorToken, {
        readConnectorIdentity: () => { identityAsked(); return new Promise((resolve) => { answerIdentity = resolve; }); },
        /* The production stop port, counted. */
        stopConnector: (current) => { stops.push(1); return current ? stopTelegramConnectorForSession(current) : stopTelegramConnector(); },
      });
      const service = takeover.service;
      const check = service.checkHealth();
      await asked;
      pids.push(...takeover.calls.pids);
      /* The release hands traffic to the successor on 4002, which replaces
         this Viewer's runner with its own while the identity read is pending. */
      fs.writeFileSync(target, JSON.stringify({ endpoint: "http://127.0.0.1:4002" }));
      successor = await startConnectorFromReleaseBeside(path.join(SANDBOX, "release-g"), { PORT: "4002" });
      answerIdentity(null);
      await check;
      expect(stops.length).toBeGreaterThan(0);
      expect(takeover.calls.spawns).toBe(1);
    });
    expect(() => process.kill(successor!.pid, 0)).not.toThrow();
    expect((JSON.parse(fs.readFileSync(recordFile, "utf8")) as { pid: number }).pid).toBe(successor!.pid);
  } finally {
    if (oldPort === undefined) delete process.env.PORT; else process.env.PORT = oldPort;
    fs.rmSync(target, { force: true });
    for (const pid of [...pids, ...(successor ? [(successor as { pid: number }).pid] : [])]) endConnectorProcess(pid);
    /* The successor's runner is not this process's child to reap; its record
       goes with it. */
    fs.rmSync(recordFile, { force: true });
  }
}, 20_000);

test("a connector ends when the Viewer that started it dies, and an agent that Viewer started lives on", async () => {
  const python = Bun.which("python3");
  expect(python).not.toBeNull();
  const { saveTelegramSession } = await import("./sessionStore");
  const { stagedConnectorSourceDir } = await import("./packaging");
  saveTelegramSession(PLACEHOLDER_SESSION);
  /* The real entrypoint over a stand-in vendor tree whose server only waits. */
  const vendor = stagedConnectorSourceDir();
  for (const [file, body] of Object.entries({
    "mcp/__init__.py": "", "mcp/server/__init__.py": "",
    "mcp/server/fastmcp.py": "class FastMCP:\n    async def call_tool(self, name, arguments):\n        return []\n    def streamable_http_app(self):\n        return None\n",
    "telegram_mcp/__init__.py": "",
    "telegram_mcp/runtime.py": [
      "class _Tool:", "    def __init__(self, name):", "        self.name = name", "",
      "class _Tools:", "    tools = [_Tool('get_me'), _Tool('wait_for_settled_message')]",
      "    def list_tools(self):", "        return list(self.tools)",
      "    def remove_tool(self, name):", "        self.tools = [tool for tool in self.tools if tool.name != name]", "",
      "class _Server:", "    name = ''", "",
      "class _Mcp:", "    _mcp_server = _Server()", "    _tool_manager = _Tools()", "",
      "mcp = _Mcp()", "",
    ].join("\n"),
    "telegram_mcp/runner.py": [
      "import os", "import time", "",
      "def main():",
      "    open(os.path.join(os.path.dirname(__file__), '..', 'runner-ready'), 'w').close()",
      "    while True:", "        time.sleep(1)", "",
    ].join("\n"),
  })) {
    fs.mkdirSync(path.dirname(path.join(vendor, file)), { recursive: true });
    fs.writeFileSync(path.join(vendor, file), body);
  }
  const viewer = path.join(SANDBOX, "lease-viewer.mjs");
  fs.writeFileSync(viewer, [
    "import { spawn } from 'node:child_process';",
    `const { connectorServerName, ensureTelegramConnector, spawnTelegramConnectorProcess } = await import(${JSON.stringify(path.join(import.meta.dir, "connector.ts"))});`,
    `const { readTelegramSession } = await import(${JSON.stringify(path.join(import.meta.dir, "sessionStore.ts"))});`,
    "const session = readTelegramSession();",
    "let runner = 0;",
    "const result = await ensureTelegramConnector(session, {",
    "  spawn: (spec) => { const child = spawnTelegramConnectorProcess(spec); runner = child?.pid ?? 0; return child; },",
    "  probe: async () => ({ ok: true, serverName: connectorServerName(session.connectorToken), tools: [{ name: 'get_me', readOnly: true }] }),",
    "  sleep: async () => {}, now: () => Date.now(), admitted: () => true,",
    "});",
    /* An agent this Viewer starts after the runner: it must not inherit the lease. */
    "const agent = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });",
    "agent.unref();",
    "process.stdout.write(JSON.stringify({ ok: result.ok, runner, agent: agent.pid }) + '\\n');",
    "setInterval(() => {}, 1000);",
    "",
  ].join("\n"));
  const { procBackend } = await import("@/lib/proc");
  const started = spawn(process.execPath, [viewer], {
    stdio: ["ignore", "pipe", "inherit"],
    env: { ...process.env, LLV_TELEGRAM_PYTHON: python!, LLV_TELEGRAM_SERVER_BRIDGE: path.resolve(import.meta.dir, "../../../bin/telegram-mcp-server.py") },
  });
  let launched: { ok: boolean; runner: number; agent: number } | null = null;
  try {
    launched = await Promise.race([
      new Promise<{ ok: boolean; runner: number; agent: number }>((resolve) => {
        let buffered = "";
        started.stdout!.on("data", (chunk: Buffer) => {
          buffered += chunk.toString();
          if (buffered.includes("\n")) resolve(JSON.parse(buffered.split("\n")[0]!));
        });
      }),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 8_000)),
    ]);
    expect(launched?.ok).toBe(true);
    /* The runner got past its imports and is serving before the Viewer dies. */
    const ready = path.join(vendor, "runner-ready");
    const readyBy = Date.now() + 5_000;
    while (!fs.existsSync(ready) && Date.now() < readyBy) await new Promise((resolve) => setTimeout(resolve, 25));
    expect(fs.existsSync(ready)).toBe(true);
    const runnerIdentity = procBackend.processIdentity(launched!.runner);
    expect(runnerIdentity).not.toBeNull();
    /* The Viewer crashes: no shutdown code of its own runs. */
    started.kill("SIGKILL");
    const deadline = Date.now() + 5_000;
    while (procBackend.processIdentity(launched!.runner) === runnerIdentity && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(procBackend.processIdentity(launched!.runner)).not.toBe(runnerIdentity);
    expect(() => process.kill(launched!.agent, 0)).not.toThrow();
  } finally {
    try { started.kill("SIGKILL"); } catch { /* already gone */ }
    for (const pid of [launched?.runner, launched?.agent]) {
      if (pid && pid > 1) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } }
    }
  }
}, 20_000);

test("a recorded process that is alive under another command line is never signalled and is reported as unverified", async () => {
  const { telegramConnectorUnverified } = await import("./connector");
  const { procBackend } = await import("@/lib/proc");
  expect(telegramConnectorUnverified()).toBe(false);
  fs.writeFileSync(path.join(process.env.LLV_STATE_DIR!, "telegram", "connector.json"), JSON.stringify({
    version: 1, pid: process.pid, identity: procBackend.processIdentity(process.pid), credentialRef: CONNECTOR_SESSION.credentialRef,
    connectorTokenSha256: "0".repeat(64), command: "python", entrypoint: "telegram-mcp-server.py",
  }), { mode: 0o600 });
  expect(telegramConnectorUnverified()).toBe(true);
  await expect(stopTelegramConnector()).rejects.toThrow("ownership could not be verified");
  fs.rmSync(path.join(process.env.LLV_STATE_DIR!, "telegram", "connector.json"));
});
