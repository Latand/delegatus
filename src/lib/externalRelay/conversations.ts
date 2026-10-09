import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { statePath } from "@/lib/configDir";
import { claudeProjectRoots } from "@/lib/accounts/claude";
import type { AccountContext } from "@/lib/accounts/contracts";
import type { ExternalRelayRequester } from "./protocol";
import { withFileLock, writeRelayFile, type PairedRelay, type RelayTargetSettings, type RunRecord } from "./store";
export type ConversationContext = "member" | "owner";
export type RelayConversation = {
  id: string; relayId: string; targetId: string; chatKey: string; context: ConversationContext;
  engine: "claude" | "codex"; sessionId: string | null; accountId: string | null; cwd: string;
  turns: number; turnsSinceCompaction: number; createdAt: string; lastTurnAt: string;
  seen: string[]; staticDigest: string | null; lastPromptTokens: number | null; compactions: number;
  state: "idle" | "running" | "broken"; runningRequestId: string | null;
};
const file = () => statePath("external-relay/conversations.json");
export function readConversations(): RelayConversation[] {
  try {
    const value = JSON.parse(fs.readFileSync(file(), "utf8"));
    if (value?.v !== 1 || !Array.isArray(value.conversations) || value.conversations.some((r: RelayConversation) =>
      !r || typeof r.id !== "string" || !/^[0-9a-f-]{36}$/.test(r.id) || typeof r.cwd !== "string" || path.basename(r.cwd) !== `llv-relay-conv-${r.id}` ||
      !["claude", "codex"].includes(r.engine) || !["member", "owner"].includes(r.context) || !["running", "idle", "broken"].includes(r.state) || !Array.isArray(r.seen)))
      throw new Error("invalid conversations");
    return value.conversations;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    if (!(error instanceof SyntaxError) && !(error instanceof Error && error.message === "invalid conversations")) throw error;
    try { fs.renameSync(file(), `${file()}.corrupt-${randomUUID()}`); }
    catch (moveError) { if ((moveError as NodeJS.ErrnoException).code !== "ENOENT") throw moveError; }
    return [];
  }
}
function change<T>(action: (rows: RelayConversation[]) => T): T {
  return withFileLock(file(), () => { const rows = readConversations(); const result = action(rows); writeRelayFile(file(), { v: 1, conversations: rows }); return result; });
}
export function conversationContext(requester?: ExternalRelayRequester | null): ConversationContext | null {
  return requester?.is_owner ? "owner" : requester?.is_admin ? null : "member";
}
const encodedCwd = (cwd: string) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
export { isRelayConversationDir } from "./conversationPrivacy";
export const conversationCodexHome = (record: RelayConversation) => statePath(`external-relay/conversations/${record.id}/codex`);
export function deleteConversationFiles(record: RelayConversation) {
  // Only the reserved directories minted by this module may be removed.
  if (!/^[0-9a-f-]{36}$/.test(record.id) || path.basename(record.cwd) !== `llv-relay-conv-${record.id}`) throw new Error("invalid conversation directory");
  fs.rmSync(record.cwd, { recursive: true, force: true });
  fs.rmSync(statePath(`external-relay/conversations/${record.id}`), { recursive: true, force: true });
  for (const root of claudeProjectRoots()) fs.rmSync(path.join(root, encodedCwd(record.cwd)), { recursive: true, force: true });
}
function fresh(record: RelayConversation) {
  deleteConversationFiles(record);
  Object.assign(record, { sessionId: null, seen: [], staticDigest: null, turnsSinceCompaction: 0, lastPromptTokens: null, state: "idle", runningRequestId: null });
}
export function reserveConversations(relay: PairedRelay, target: RelayTargetSettings, chatKey: string, requestId: string, contexts: ConversationContext[], preserveBroken = false): RelayConversation[] | null {
  return change((rows) => {
    const matches = (r: RelayConversation) => r.relayId === relay.id && r.targetId === target.id && r.chatKey === chatKey;
    if (rows.some((r) => matches(r) && r.state === "running")) return null;
    const result = contexts.map((context) => {
      let record = rows.find((r) => matches(r) && r.context === context);
      if (record && (record.engine !== target.engine || record.state === "broken" && !preserveBroken)) { fresh(record); record.engine = target.engine!; }
      if (!record) {
        const id = randomUUID(); const now = new Date().toISOString();
        const temporary = path.resolve(os.tmpdir()); const home = path.resolve(os.homedir());
        record = { id, relayId: relay.id, targetId: target.id, chatKey, context, engine: target.engine!, sessionId: null, accountId: null,
          cwd: path.join(temporary === home || temporary.startsWith(home + path.sep) ? "/tmp" : temporary, `llv-relay-conv-${id}`),
          turns: 0, turnsSinceCompaction: 0, createdAt: now, lastTurnAt: now, seen: [], staticDigest: null, lastPromptTokens: null, compactions: 0, state: "idle", runningRequestId: null };
        rows.push(record);
      }
      record.state = "running"; record.runningRequestId = requestId;
      return { ...record };
    });
    return result;
  });
}
export function releaseConversation(id: string, patch: Partial<RelayConversation> = {}) {
  change((rows) => { const record = rows.find((r) => r.id === id); if (record) Object.assign(record, { state: "idle", runningRequestId: null }, patch); });
}
export function resetConversation(record: RelayConversation) { fresh(record); releaseConversation(record.id, record); }
export function prepareConversationAccount(record: RelayConversation, account: AccountContext) {
  fs.mkdirSync(record.cwd, { recursive: true, mode: 0o700 });
  const now = new Date(); fs.utimesSync(record.cwd, now, now);
  if (record.engine !== "claude" || !record.sessionId) return;
  const destination = path.join(account.transcriptRoot, encodedCwd(record.cwd));
  if (fs.existsSync(path.join(destination, `${record.sessionId}.jsonl`))) return;
  for (const root of claudeProjectRoots()) {
    const source = path.join(root, encodedCwd(record.cwd));
    if (source === destination || !fs.existsSync(path.join(source, `${record.sessionId}.jsonl`))) continue;
    fs.mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
    try { fs.renameSync(source, destination); }
    catch { fs.cpSync(source, destination, { recursive: true }); fs.rmSync(source, { recursive: true, force: true }); }
    return;
  }
  const reservation = { state: record.state, runningRequestId: record.runningRequestId };
  fresh(record); Object.assign(record, reservation);
  fs.mkdirSync(record.cwd, { recursive: true, mode: 0o700 });
}
function transcriptBytes(record: RelayConversation): number {
  function size(directory: string): number {
    try { return fs.readdirSync(directory, { withFileTypes: true }).reduce((sum, item) => sum + (item.isDirectory() ? size(path.join(directory, item.name)) : item.isFile() ? fs.statSync(path.join(directory, item.name)).size : 0), 0); }
    catch { return 0; }
  }
  return record.engine === "codex" ? size(conversationCodexHome(record)) : claudeProjectRoots().reduce((sum, root) => sum + size(path.join(root, encodedCwd(record.cwd))), 0);
}
export function sweepConversations(relays: PairedRelay[], runs: RunRecord[], now = Date.now(), removeRelayId?: string, onlyRelayId?: string) {
  if (!fs.existsSync(file())) return;
  change((rows) => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const record = rows[i]!; if (onlyRelayId && record.relayId !== onlyRelayId) continue; const relay = relays.find((r) => r.id === record.relayId); const target = relay?.targets.find((t) => t.id === record.targetId);
      if (record.state === "running" && !runs.some((r) => r.requestId === record.runningRequestId)) { record.state = "idle"; record.runningRequestId = null; }
      if (record.state === "running") continue;
      if (record.relayId === removeRelayId || !target || target.engine !== record.engine || now - Date.parse(record.lastTurnAt) > 30 * 86400000 || transcriptBytes(record) > 32 * 1024 * 1024) {
        deleteConversationFiles(record); rows.splice(i, 1);
      }
    }
  });
}
