import fs from "node:fs";
import path from "node:path";

import { claudeProjectRoots } from "@/lib/accounts/claude";
import type { FileEntry } from "@/lib/types";

import { conversationCodexHome, readConversations, type RelayConversation } from "./conversations";
import { relayChatsProject, shortChatKey, type RelayChatRow, type RelayChatsPayload } from "./relayChats";
import { readRelayStore } from "./store";

/*
 * The operator's read of the relay's per-chat conversations. The scanner skips
 * their transcripts (relay-slice3.md §4.6), so search, the MCP tools, flows and
 * composers never reach them; this module finds them from the conversation
 * records instead, for the relay's own operator-only route and for the
 * operator's feed reads of exactly these files. It writes nothing.
 */

const encodedCwd = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");

function codexRollout(record: RelayConversation): string | null {
  const sessions = path.join(conversationCodexHome(record), "sessions");
  const suffix = `${record.sessionId}.jsonl`;
  const walk = (directory: string, depth: number): string | null => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      const full = path.join(directory, entry.name);
      if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(suffix)) return full;
      if (entry.isDirectory() && depth < 4) {
        const found = walk(full, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return walk(sessions, 0);
}

/** The transcript a conversation record's session wrote, wherever its account keeps it. */
export function relayTranscriptFor(record: RelayConversation): string | null {
  if (!record.sessionId || !/^[A-Za-z0-9_-]{1,128}$/.test(record.sessionId)) return null;
  if (record.engine === "codex") return codexRollout(record);
  for (const root of claudeProjectRoots()) {
    const candidate = path.join(root, encodedCwd(record.cwd), `${record.sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function entryFor(record: RelayConversation, transcript: string, relayName: string, targetName: string | null, model: string | null): FileEntry | null {
  let stat: fs.Stats;
  try { stat = fs.statSync(transcript); } catch { return null; }
  if (!stat.isFile()) return null;
  return {
    path: transcript,
    root: record.engine === "codex" ? "codex-sessions" : "claude-projects",
    name: path.basename(transcript),
    project: relayChatsProject(record.relayId),
    projectName: relayName,
    cwd: record.cwd,
    sessionStartedAt: record.createdAt,
    title: `${targetName ?? record.targetId} · ${shortChatKey(record.chatKey)}`,
    engine: record.engine,
    kind: "session",
    fmt: record.engine,
    parent: null,
    mtime: stat.mtimeMs / 1000,
    size: stat.size,
    activity: record.state === "running" ? "live" : "idle",
    proc: null,
    pid: null,
    model,
    pendingQuestion: null,
    waitingInput: null,
  };
}

/** Every recorded chat conversation, newest turn first, with its relay's and target's names. */
export function relayChats(): RelayChatsPayload {
  /* The Viewer asks every 15 s on every install; one that never kept a chat
     conversation reads no relay store, which would create its file. */
  const records = readConversations();
  if (!records.length) return { relays: [], chats: [] };
  const store = readRelayStore();
  const relays = store.relays.map((relay) => ({ id: relay.id, name: relay.name, origin: relay.origin }));
  const chats: RelayChatRow[] = records.flatMap((record) => {
    const relay = store.relays.find((item) => item.id === record.relayId);
    if (!relay) return [];
    const target = relay.targets.find((item) => item.id === record.targetId) ?? null;
    const transcript = relayTranscriptFor(record);
    return [{
      id: record.id,
      relayId: record.relayId,
      relayName: relay.name,
      targetId: record.targetId,
      targetName: target?.name ?? null,
      chatKey: record.chatKey,
      context: record.context,
      engine: record.engine,
      turns: record.turns,
      compactions: record.compactions,
      createdAt: record.createdAt,
      lastTurnAt: record.lastTurnAt,
      state: record.state,
      file: transcript ? entryFor(record, transcript, relay.name, target?.name ?? null, target?.engine === record.engine ? target.model : null) : null,
    }];
  });
  chats.sort((a, b) => Date.parse(b.lastTurnAt) - Date.parse(a.lastTurnAt) || a.id.localeCompare(b.id));
  return { relays, chats };
}

const realpath = (candidate: string) => { try { return fs.realpathSync(candidate); } catch { return null; } };

/* A feed that follows one transcript asks on every read; the records are read
   again at most once a second. */
let known: { at: number; paths: Set<string> } | null = null;

/**
 * Whether `candidate` is the transcript of a recorded chat conversation. The
 * feed routes ask it only for a caller that already passed the relay's
 * operator guard, and only after the scanner's own roots refused the path.
 */
export function isRelayTranscript(candidate: string, now = Date.now()): boolean {
  const real = realpath(candidate);
  if (!real) return false;
  if (!known || now - known.at > 1000) {
    const paths = new Set<string>();
    for (const record of readConversations()) {
      const transcript = relayTranscriptFor(record);
      const resolved = transcript ? realpath(transcript) : null;
      if (resolved) paths.add(resolved);
    }
    known = { at: now, paths };
  }
  return known.paths.has(real);
}
