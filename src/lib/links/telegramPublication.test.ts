import { expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { TelegramBotStore } from "@/lib/telegram/bot/store";
import { recordOutbound, type OutboundMessage } from "@/lib/telegram/bot/outbound";
import { ExternalRelayError } from "@/lib/externalRelay/client";
import { exchangeTelegramPublications, validTelegramPublicationPart, telegramPublicationAvailable, telegramPublicationProof, telegramDestinationProof, type TelegramPublicationPorts } from "./telegramPublication";
import type { LinkedPeer } from "./linked";
import { startTestRelay } from "@/lib/externalRelay/testRelay";
import { sampleRequest } from "@/lib/externalRelay/request.fixture";

const link: LinkedPeer = { key: "peer:fixture", id: "fixture", side: "peer", install: "remote", prefix: "fixture",
  label: "Remote", projects: new Set(["project"]) };
const target = { relayId: "paired", apiBase: "https://relay.example/v1", targetId: "first", ownerId: "41" };
const route = { botId: "42", target };
const destination = { ...route, connectionId: "fixture-connection", proof: telegramDestinationProof(route, "fixture-connection", "fixture shared bot") };
const message: OutboundMessage = { botId: "42", chatId: "-41", messageId: 18, topicId: 7, date: 1791724800,
  text: "Choose a sample size: small, medium, large.", origin: "agent", conversationId: "conversation_fixture", replyToMessageId: 17,
  sendKey: "report", target: null };
function fixture() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "linked-publication-"));
  const filename = path.join(root, "bot.sqlite");
  const store = new TelegramBotStore(filename); store.close();
  const ports: TelegramPublicationPorts = { filename, now: () => message.date * 1000 + 5000, botId: () => "42",
    destination: () => destination, connectionId: () => "fixture-connection",
    destinationProof: (d, id) => telegramDestinationProof(d, id, "fixture shared bot"), allowed: () => true, proof: item => telegramPublicationProof(item, "fixture shared bot"), owns: id => id === "41", current: () => link, publish: async (_receipt, authorize) => { authorize(); return "published"; } };
  return { ports, root, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const state = (filename: string) => {
  const db = new Database(filename, { readonly: true });
  try { return db.query("SELECT o.state, o.attempts, r.reason FROM relay_outbound o LEFT JOIN relay_publication_results r USING(key) ORDER BY message_id").all(); }
  finally { db.close(); }
};

test("handoff pins the authenticated install; only a service acknowledgement settles custody", async () => {
  const f = fixture();
  try {
    await recordOutbound(f.ports.filename, message);
    const packet = await exchangeTelegramPublications(link, { v: 1, destination }, f.ports);
    expect(packet.out).toHaveLength(1);
    expect(packet.out![0]!.receipt).toEqual({ botId: "42", chatId: "-41", messageId: 18, topicId: 7, date: message.date, text: message.text });
    expect(JSON.stringify(packet)).not.toContain("conversation_fixture");
    const wrong = { ...link, key: "peer:other", install: "other" };
    expect((await exchangeTelegramPublications(wrong, { v: 1, destination }, { ...f.ports, current: () => wrong })).out).toBeUndefined();
    const ack = { key: packet.out![0]!.key, attempts: 1, state: "published", reason: "published" };
    await exchangeTelegramPublications(wrong, { v: 1, ack: [ack] }, { ...f.ports, current: () => wrong });
    expect(state(f.ports.filename)).toEqual([{ state: "forwarding", attempts: 1, reason: null }]);
    await exchangeTelegramPublications(link, { v: 1, ack: [ack] }, f.ports);
    await exchangeTelegramPublications(link, { v: 1, ack: [ack] }, f.ports);
    expect(state(f.ports.filename)).toEqual([{ state: "published", attempts: 1, reason: "published" }]);
    const completed = new Database(f.ports.filename, { readonly: true });
    try { expect(completed.query("SELECT 1 FROM relay_outbound_handoffs").get()).toBeNull(); }
    finally { completed.close(); }
  } finally { f.cleanup(); }
});

test.each(["unknown-owner", "other-bot", "no-discovery", "no-project", "revoked", "changed-install", "posting-revoked"])("handoff excludes %s before exporting text", async kind => {
  const f = fixture();
  try {
    await recordOutbound(f.ports.filename, message);
    if (kind === "unknown-owner") f.ports.owns = () => false;
    if (kind === "posting-revoked") f.ports.allowed = () => false;
    if (kind === "other-bot") f.ports.botId = () => "43";
    if (kind === "no-project") f.ports.current = () => ({ ...link, projects: new Set() });
    if (kind === "revoked") f.ports.current = () => null;
    if (kind === "changed-install") f.ports.current = () => ({ ...link, install: "replacement" });
    const action = exchangeTelegramPublications(link, kind === "no-discovery" ? undefined : { v: 1, destination }, f.ports);
    if (["no-project", "revoked", "changed-install"].includes(kind)) await expect(action).rejects.toThrow("link revoked");
    else expect((await action).out).toBeUndefined();
    expect(state(f.ports.filename)[0]).toMatchObject({ state: "unrouted", attempts: 0 });
  } finally { f.cleanup(); }
});

test.each([0, 400, 403, 409, 429, 503])("service %s is recorded without changing the original receipt", async status => {
  const a = fixture(), b = fixture();
  try {
    await recordOutbound(a.ports.filename, message);
    const packet = await exchangeTelegramPublications(link, { v: 1, destination }, a.ports);
    let calls = 0;
    b.ports.publish = async () => { calls++; throw new ExternalRelayError("fixture", status, 60); };
    const answer = await exchangeTelegramPublications(link, packet, b.ports);
    expect(calls).toBe(1);
    expect(validTelegramPublicationPart(answer)).toBe(true);
    expect(answer.ack![0]).toMatchObject({ state: status > 0 && status < 429 ? "terminal" : "retry", reason: status ? `${status}:fixture` : "unconfirmed" });
    await exchangeTelegramPublications(link, answer, a.ports);
    expect(state(a.ports.filename)[0]).toMatchObject({ state: status > 0 && status < 429 ? "terminal" : "forwarding", attempts: 1, reason: status ? `${status}:fixture` : "unconfirmed" });
    expect((await exchangeTelegramPublications(link, { v: 1, destination }, a.ports)).out).toBeUndefined();
    if (status === 429) {
      const replay = await exchangeTelegramPublications(link, packet, b.ports);
      expect(replay.ack![0]).toMatchObject({ state: "retry", reason: "cooldown", delayMs: 60000 });
      expect(calls).toBe(1);
    }
  } finally { a.cleanup(); b.cleanup(); }
});

test.each(["bot", "target", "owner", "revoked-after-await", "expires-after-await", "expired", "future", "identity"])("incoming %s never reaches the service", async kind => {
  const a = fixture(), b = fixture();
  try {
    await recordOutbound(a.ports.filename, message);
    const packet = await exchangeTelegramPublications(link, { v: 1, destination }, a.ports);
    packet.out = structuredClone(packet.out);
    const item = packet.out![0]!;
    if (kind === "bot") item.receipt.botId = "43";
    if (kind === "target") item.destination.target = { ...target, targetId: "other" };
    if (kind === "owner") item.destination.target = { ...target, ownerId: "99" };
    if (kind === "expired") b.ports.now = () => (message.date + 86400) * 1000;
    if (kind === "future") b.ports.now = () => (message.date - 61) * 1000;
    if (kind === "identity") item.key = "other";
    let calls = 0;
    let connected = true;
    let currentTime = b.ports.now();
    b.ports.destination = () => connected ? destination : null;
    b.ports.now = () => currentTime;
    b.ports.publish = async (_receipt, authorize) => {
      await Promise.resolve();
      if (kind === "expires-after-await") currentTime = (message.date + 86400) * 1000;
      if (kind === "revoked-after-await") connected = false;
      authorize(); calls++; return "published";
    };
    const result = await exchangeTelegramPublications(link, packet, b.ports);
    expect(result.ack![0]!.state).not.toBe("published");
    expect(calls).toBe(0);
  } finally { a.cleanup(); b.cleanup(); }
});

test("the wire rejects owner authority, extra fields, oversized batches and credential-shaped payloads", () => {
  for (const bad of [{ v: 2 }, { v: 1, owner: true }, { v: 1, credential: "fixture" },
    { v: 1, out: [{}, {}] }, { v: 1, destination: { ...destination, is_owner: true } }])
    expect(validTelegramPublicationPart(bad)).toBe(false);
  expect(validTelegramPublicationPart({ v: 1, destination })).toBe(true);
});

test("a bounded page of ineligible receipts cannot starve a later matching bot", async () => {
  const f = fixture();
  try {
    const recent = { ...message, date: Math.floor(Date.now() / 1000) };
    f.ports.now = () => (recent.date + 5) * 1000;
    for (let i = 1; i <= 16; i++) await recordOutbound(f.ports.filename, { ...recent, botId: "41", messageId: i });
    await recordOutbound(f.ports.filename, recent);
    expect((await exchangeTelegramPublications(link, { v: 1, destination }, f.ports)).out).toBeUndefined();
    expect((await exchangeTelegramPublications(link, { v: 1, destination }, f.ports)).out?.[0]?.receipt.botId).toBe("42");
  } finally { f.cleanup(); }
});

test("another linked peer cannot postpone a receipt reserved by the eligible peer", async () => {
  const f = fixture();
  const peerA: LinkedPeer = { ...link, key: "peer:a", id: "a", install: "install-a" };
  const peerB: LinkedPeer = { ...link, key: "peer:b", id: "b", install: "install-b" };
  const destinationFor = (peer: LinkedPeer) => {
    const connectionId = `connection-${peer.id}`;
    return { ...route, connectionId, proof: telegramDestinationProof(route, connectionId, "fixture shared bot") };
  };
  const destinationA = destinationFor(peerA), destinationB = destinationFor(peerB);
  let now = message.date * 1000 + 5000;
  const portsFor = () => ({ ...f.ports, now: () => now,
    connectionId: (candidate: LinkedPeer) => candidate.id === "a" ? "connection-a" : "connection-b",
    current: (candidate: LinkedPeer) => candidate });
  try {
    await recordOutbound(f.ports.filename, message);
    const a = portsFor();
    const first = await exchangeTelegramPublications(peerA, { v: 1, destination: destinationA }, a);
    expect(first.out?.[0]?.attempts).toBe(1);
    await exchangeTelegramPublications(peerA, { v: 1, ack: [{ key: first.out![0]!.key, attempts: 1,
      state: "retry", reason: "unconfirmed" }] }, a);
    now += 1001;

    const b = await exchangeTelegramPublications(peerB, { v: 1, destination: destinationB }, portsFor());
    expect(b.out).toBeUndefined();
    const retry = await exchangeTelegramPublications(peerA, { v: 1, destination: destinationA }, a);
    expect(retry.out?.[0]?.attempts).toBe(2);
  } finally { f.cleanup(); }
});

test("exchange due-row seeks are scoped to one connection and keep unrouted work separately indexed", async () => {
  const f = fixture();
  try {
    await recordOutbound(f.ports.filename, message);
    const db = new Database(f.ports.filename);
    try {
      const forwarding = db.query<{ detail: string }, [string, number]>(`EXPLAIN QUERY PLAN
        SELECT o.key FROM relay_outbound_handoffs h JOIN relay_outbound o ON o.key=h.key
        WHERE h.link=? AND h.due<=? AND o.state='forwarding' ORDER BY h.due, h.key LIMIT 16`)
        .all("peer-b", f.ports.now());
      const unrouted = db.query<{ detail: string }, [number]>(`EXPLAIN QUERY PLAN SELECT key FROM relay_outbound
        WHERE state='unrouted' AND due<=? ORDER BY due, key LIMIT 16`).all(f.ports.now());
      expect(forwarding.map(row => row.detail).join(" ")).toContain("relay_outbound_handoff_link_due");
      expect(unrouted.map(row => row.detail).join(" ")).toContain("relay_outbound_unrouted_due");
      expect(forwarding.map(row => row.detail).join(" ")).not.toContain("SCAN h");
      expect(unrouted.map(row => row.detail).join(" ")).not.toContain("TEMP B-TREE");
    } finally { db.close(); }

    const peerB: LinkedPeer = { ...link, key: "peer:b", id: "b", install: "install-b" };
    const peerA: LinkedPeer = { ...link, key: "peer:a", id: "a", install: "install-a" };
    const connectionFor = (candidate: LinkedPeer) => `connection-${candidate.id}`;
    const dbWrite = new Database(f.ports.filename);
    try {
      dbWrite.query("UPDATE relay_outbound SET state='forwarding', due=? WHERE key=?").run(f.ports.now(), JSON.stringify([message.botId, message.chatId, message.messageId]));
      dbWrite.query("INSERT OR REPLACE INTO relay_outbound_handoffs (key, link, destination, due) VALUES (?, ?, ?, ?)")
        .run(JSON.stringify([message.botId, message.chatId, message.messageId]), JSON.stringify([peerB.key, peerB.install]), JSON.stringify(destination), f.ports.now());
      dbWrite.query(`WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<100000)
        INSERT INTO relay_outbound (key, bot_id, chat_id, topic_id, date, message_id, value_json, is_question, send_key, state, due, attempts)
        SELECT 'unrelated-peer-'||n, '42', '-41', 7, ?, 100000+n, '{}', 0, 'peer-b', 'forwarding', ?, 1 FROM seq`)
        .run(message.date, f.ports.now());
      dbWrite.query(`INSERT INTO relay_outbound_handoffs (key, link, destination, due)
        SELECT key, ?, ?, ? FROM relay_outbound WHERE key LIKE 'unrelated-peer-%'`)
        .run(JSON.stringify([peerB.key, peerB.install]), JSON.stringify(destination), f.ports.now());
    } finally { dbWrite.close(); }
    const ports: TelegramPublicationPorts = { ...f.ports, connectionId: candidate => connectionFor(candidate), current: candidate => candidate };
    expect((await exchangeTelegramPublications(peerA, { v: 1, destination: {
      ...route, connectionId: "connection-a", proof: telegramDestinationProof(route, "connection-a", "fixture shared bot")
    } }, ports)).out).toBeUndefined();
    const after = new Database(f.ports.filename, { readonly: true });
    try {
      expect(after.query<{ count: number }, [string, number]>("SELECT count(*) AS count FROM relay_outbound_handoffs WHERE link=? AND due=?")
        .get(JSON.stringify([peerB.key, peerB.install]), f.ports.now())).toEqual({ count: 100001 });
    } finally { after.close(); }
  } finally { f.cleanup(); }
});

test("forwarded text uses the existing deterministic Unicode truncation and retains the full local receipt", async () => {
  const f = fixture();
  try {
    const text = "😀".repeat(13000);
    await recordOutbound(f.ports.filename, { ...message, text });
    const packet = await exchangeTelegramPublications(link, { v: 1, destination }, f.ports);
    expect([...packet.out![0]!.receipt.text]).toHaveLength(12000);
    expect(packet.out![0]!.receipt.text.endsWith("\n[truncated]")).toBe(true);
    const db = new Database(f.ports.filename, { readonly: true });
    try { expect(JSON.parse(db.query<{ value_json: string }, []>("SELECT value_json FROM relay_outbound").get()!.value_json).text).toBe(text); }
    finally { db.close(); }
  } finally { f.cleanup(); }
});

test.each(["peer", "grant", "unpaired", "exhaustion"])("%s sender restart preserves publication and relay context or a terminal retry budget", async scenario => {
  const direction = scenario === "grant" ? "grant" : "peer";
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR!, "publication-http-"));
  const history = new Database(path.join(root, "history.sqlite"));
  history.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, body TEXT NOT NULL)");
  let attempts = 0;
  const relay = await startTestRelay((request, body) => {
    expect(request.headers["delegatus-relay-version"]).toBe("1");
    expect(request.headers.authorization).toBe(`Bearer ${"q".repeat(43)}`);
    if (request.url === "/v1/targets/first/messages") {
      const value = body as { message_id: number; chat_id: number; message_thread_id: number; sent_at: string; text: string };
      expect(value).toEqual({ chat_id: -41, message_id: 18, message_thread_id: 7, sent_at: "2026-10-11T13:20:00.000Z", text: message.text });
      attempts++;
      if (scenario === "exhaustion") return { status: 503, body: { error: { code: "unavailable" } } };
      const old = history.query<{ body: string }, [number]>("SELECT body FROM messages WHERE id=?").get(value.message_id);
      if (old && old.body !== JSON.stringify(value)) return { status: 409, body: { error: { code: "message_conflict" } } };
      history.query("INSERT OR IGNORE INTO messages VALUES (?, ?)").run(value.message_id, JSON.stringify(value));
      // Publication landed, but its response was lost. The restart must replay.
      if (attempts === 1) return { drop: true };
      return { body: { message_key: "published_report", replayed: !!old } };
    }
    expect(request.url).toBe("/v1/targets/first/claim");
    const report = JSON.parse(history.query<{ body: string }, []>("SELECT body FROM messages WHERE id=18").get()!.body);
    return { body: { ...sampleRequest, target_id: "first", input: { ...sampleRequest.input, respond_to: "human_reply",
      requester: { key: "member", is_owner: false, is_admin: false, is_anonymous_admin: false, can_restrict_members: false, can_delete_messages: false },
      conversation: [
        { id: "published_report", author: { key: "bot", name: "Delegatus", self: true }, sent_at: report.sent_at, text: report.text, reply_to: null },
        { id: "human_reply", author: { key: "member", name: "Member", self: false }, sent_at: "2026-10-11T13:20:05Z", text: "Select medium.", reply_to: "published_report" },
      ] } } };
  });
  const start = async (side: "sender" | "receiver", port = "0") => {
    const directory = path.join(root, side);
    for (const name of ["home", "config", "tmp", "state"]) fs.mkdirSync(path.join(directory, name), { recursive: true });
    const child = spawn(process.execPath, [path.join(import.meta.dir, "telegramPublication.fixture.ts")], {
      env: { ...process.env, HOME: path.join(directory, "home"), XDG_CONFIG_HOME: path.join(directory, "config"),
        LLV_STATE_DIR: path.join(directory, "state"), TMPDIR: path.join(directory, "tmp"),
        PUBLICATION_SIDE: side, UNPAIRED_SENDER: scenario === "unpaired" ? "1" : "0", PUBLICATION_PORT: port, RELAY_FIX_ORIGIN: relay.origin, LLV_VIEWER_CONTROL_URL: "http://127.0.0.1:1" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let errors = "";
    child.stderr.on("data", chunk => { errors += chunk; });
    const started = new Promise<string>((resolve, reject) => {
      let output = "";
      child.stdout.on("data", chunk => {
        output += chunk;
        if (output.includes("\n")) { try { resolve(JSON.parse(output.split("\n")[0]!).origin); } catch (error) { reject(error); } }
      });
      child.once("exit", code => reject(Error(`fixture exit ${code}: ${errors}`)));
    });
    const timer = setTimeout(() => child.kill("SIGKILL"), 15000);
    const stop = async () => { if (child.exitCode === null) { child.kill("SIGTERM"); await once(child, "exit"); } };
    try { return { origin: await started, stop }; }
    catch (error) { await stop(); throw error; }
    finally { clearTimeout(timer); }
  };
  const call = async (origin: string, route: string, body: object = {}) => {
    const response = await fetch(origin + route, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(20000) });
    const value = await response.json(); expect(response.status, JSON.stringify(value)).toBe(200); return value;
  };
  let sender: Awaited<ReturnType<typeof start>> | undefined;
  let receiver: Awaited<ReturnType<typeof start>> | undefined;
  try {
    sender = await start("sender"); receiver = await start("receiver");
    const outgoing = direction === "peer" ? sender : receiver;
    const accepting = direction === "peer" ? receiver : sender;
    const code = (await call(accepting.origin, "/fixture/code")).code;
    expect(typeof code).toBe("string");
    await call(outgoing.origin, "/fixture/connect", { url: accepting.origin, code });
    expect(await call(sender.origin, "/fixture/send")).toMatchObject({ messageIds: [18] });
    expect(attempts).toBe(0);
    const port = new URL(sender.origin).port;
    await sender.stop(); sender = await start("sender", port);
    if (scenario === "exhaustion") {
      for (let i = 0; i < 64; i++) {
        await call(sender.origin, "/fixture/advance", { ms: 300001 });
        await call(sender.origin, "/fixture/sync");
        expect(attempts).toBe(i + 1);
        if (i === 31) {
          await sender.stop(); sender = await start("sender", port);
          await call(sender.origin, "/fixture/advance", { ms: 32 * 300001 });
        }
      }
      await sender.stop(); sender = await start("sender", port);
      await call(sender.origin, "/fixture/advance", { ms: 65 * 300001 });
      await call(sender.origin, "/fixture/sync");
      expect(attempts).toBe(64);
      expect(await call(sender.origin, "/fixture/state")).toMatchObject({ sends: 0, rows: [{ state: "terminal", attempts: 64, reason: "attempts_exhausted" }] });
      return;
    }
    await call(direction === "peer" ? sender.origin : receiver.origin, "/fixture/sync");
    expect(attempts).toBe(1);
    expect((await call(sender.origin, "/fixture/state")).rows[0]).toMatchObject({ state: "forwarding", attempts: 1 });
    // The retry counter and payload survive a second real process restart.
    await sender.stop(); sender = await start("sender", port);
    await call(sender.origin, "/fixture/advance", { ms: 1001 });
    await call(direction === "peer" ? sender.origin : receiver.origin, "/fixture/sync");
    expect(attempts).toBe(2);
    const finalState = await call(sender.origin, "/fixture/state");
    expect(finalState).toMatchObject({ sends: 0, rows: [{ state: "published", attempts: 2, reason: "published" }] });
    const context = await call(receiver.origin, "/fixture/claim");
    expect(context.input.conversation[0]).toMatchObject({ id: "published_report", text: message.text, author: { key: "bot", self: true } });
    expect(context.input.conversation[1].reply_to).toBe(context.input.conversation[0].id);
    expect(context.input.requester.is_owner).toBe(false);
    expect(context.input.conversation[0].author.key).not.toBe(context.input.requester.key);
    expect(context.prompt).toContain(message.text);
    expect(context.prompt).toContain('"reply_to":"published_report"');
    expect(context.prompt).toContain('"self":true');
    const wire = JSON.stringify(context.input);
    expect(wire).not.toContain("credential");
    const storedRows = history.query<{ n: number }, []>("SELECT count(*) AS n FROM messages").get()!.n;
    expect(storedRows).toBe(1);
    const output = process.env.LLV_TELEGRAM_PUBLICATION_EVIDENCE;
    if (output) {
      const sourceFiles = ["src/lib/links/telegramPublication.ts", "src/lib/links/client.ts", "src/lib/links/protocol.ts",
        "src/app/api/peer/v1/[...path]/route.ts", "src/lib/telegram/bot/service.ts", "src/lib/telegram/bot/outbound.ts",
        "src/lib/telegram/bot/outboundPublication.ts", "src/lib/externalRelay/telegramPublication.ts", "src/lib/externalRelay/publish.ts",
        "src/lib/externalRelay/client.ts", "src/lib/externalRelay/protocol.ts", "src/lib/externalRelay/prompt.ts", "src/lib/externalRelay/publishedReferences.ts"];
      const hash = createHash("sha256");
      for (const file of sourceFiles) hash.update(file).update("\0").update(fs.readFileSync(path.resolve(import.meta.dir, "../../..", file)));
      const record = fs.existsSync(output) ? JSON.parse(fs.readFileSync(output, "utf8")) : { cases: {} };
      record.generator = "src/lib/links/telegramPublication.test.ts";
      record.command = "LLV_TELEGRAM_PUBLICATION_EVIDENCE=<output> bash scripts/gate-slot.sh bun test src/lib/links/telegramPublication.test.ts";
      record.baseRevision = "cfed2c48e4a112d60b78dd8526fc1c769d8ca811";
      record.sourceFiles = sourceFiles; record.sourceSha256 = hash.digest("hex");
      record.fixtureClock = "2026-10-11T13:20:05.000Z";
      record.cases[scenario] = { direction, telegramSendsAfterRestart: finalState.sends, servicePublishAttempts: attempts, storedRows,
        relayInput: context.input, prompt: context.prompt };
      fs.writeFileSync(output, JSON.stringify(record, null, 2) + "\n");
    }
  } finally {
    await sender?.stop(); await receiver?.stop(); await relay.close(); history.close(); fs.rmSync(root, { recursive: true, force: true });
  }
}, 60000);


test("bot-free idle links omit the sidecar and connecting a bot is immediately observed", () => {
  const f = fixture();
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = f.root;
  try {
    expect(telegramPublicationAvailable()).toBe(false);
    expect(telegramPublicationAvailable({ v: 1 })).toBe(false);
    expect(telegramPublicationAvailable({ v: 1, destination })).toBe(true);
    fs.mkdirSync(path.join(f.root, "telegram"), { mode: 0o700 });
    fs.writeFileSync(path.join(f.root, "telegram/bot-token.json"), "fixture");
    expect(telegramPublicationAvailable({ v: 1 })).toBe(true);
    fs.unlinkSync(path.join(f.root, "telegram/bot-token.json"));
    expect(telegramPublicationAvailable({ v: 1 })).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    f.cleanup();
  }
});


test.each(["forged", "replayed-connection"])("discovery %s exports no receipt text to a peer without bot control", async kind => {
  const f = fixture();
  try {
    await recordOutbound(f.ports.filename, message);
    const advertised = { ...destination, ...(kind === "forged" ? { proof: "0".repeat(64) } : { connectionId: "another-connection" }) };
    expect((await exchangeTelegramPublications(link, { v: 1, destination: advertised }, f.ports)).out).toBeUndefined();
    expect(state(f.ports.filename)[0]).toMatchObject({ state: "unrouted", attempts: 0 });
  } finally { f.cleanup(); }
});

test.each(["proof", "chat", "message", "date", "topic", "text", "attempt", "connection", "rotated-after-await"])("signed receipt refuses tampered %s before HTTP", async kind => {
  const a = fixture(), b = fixture();
  try {
    await recordOutbound(a.ports.filename, message);
    const packet = await exchangeTelegramPublications(link, { v: 1, destination }, a.ports);
    const item = packet.out![0]!;
    if (kind === "proof") item.proof = "0".repeat(64);
    if (kind === "chat") item.receipt.chatId = "-42";
    if (kind === "message") item.receipt.messageId++;
    if (kind === "date") item.receipt.date--;
    if (kind === "topic") item.receipt.topicId = 8;
    if (kind === "text") item.receipt.text = "Injected report";
    if (kind === "attempt") item.attempts++;
    if (kind === "connection") item.destination = { ...item.destination, connectionId: "another-connection" };
    item.key = JSON.stringify([item.receipt.botId, item.receipt.chatId, item.receipt.messageId]);
    let key = "fixture shared bot", calls = 0;
    b.ports.proof = item => telegramPublicationProof(item, key);
    b.ports.publish = async (_receipt, authorize) => {
      await Promise.resolve();
      if (kind === "rotated-after-await") key = "rotated fixture bot";
      authorize(); calls++; return "published";
    };
    const answer = await exchangeTelegramPublications(link, packet, b.ports);
    expect(answer.ack![0]).toMatchObject({ state: "terminal", reason: "403:bot_proof_refused" });
    expect(calls).toBe(0);
  } finally { a.cleanup(); b.cleanup(); }
});
