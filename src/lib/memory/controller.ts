import { messageTextDigest } from "@/lib/runtime/messageTextDigest";
import { callerConversationId } from "@/lib/agent/operatorAuthority";
import { agentRegistry } from "@/lib/agent/registry";
import { readAsksYouSettings, readOpenRouterApiKey } from "@/lib/asks/settings";
import { mutateOperatorAsks, spendMonth } from "@/lib/asks/store";
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import { decodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText";
import { FileClaudeDeliveryLedger } from "@/lib/runtime/claudeStreamBrokerHost";
import { readStructuredUserMetadata } from "@/lib/selection/structuredUserMetadata";
import { viewerReleaseOwnsTraffic } from "@/lib/viewerInstrumentation";
import { nativeHookCursor } from "./native";
import { memoryTurnContext } from "./context";
import { decideMemories, injectMemory } from "./injection";
import { memoryIndex } from "./service";
import { sharedMemoryEnabled } from "./settings";
import type { Candidate } from "./selection";

// Offers remain provisional until the standalone hook confirms a successful
// stdout write. Prompt expiry stops selection/output, while bounded retained
// evidence lets a confirmation already sent by the hook finish after expiry.
const CONFIRMATION_RETENTION_MS = 30000;
const pendingOffers = new Map<string, { expires: number; preparedAt: number; retainUntil: number; index: ReturnType<typeof memoryIndex>; requestId: string; entries: Array<Candidate & { score: number }> }>();

export async function offerForHook(request: Request, input: Record<string, unknown>): Promise<string> {
  const expires = Math.min(Number(request.headers.get("x-llv-memory-deadline")), Date.now() + 1500);
  const hookId = request.headers.get("x-llv-memory-hook") ?? "";
  const remaining = Math.min(1500, expires - Date.now());
  const deadline = performance.now() + remaining;
  try {
    for (const [id, offer] of pendingOffers) if (offer.retainUntil <= Date.now()) pendingOffers.delete(id);
    if (!/^[a-f0-9-]{36}$/.test(hookId)) return "";
    const conversationId = callerConversationId(request);
    if (!conversationId) return "";
    const offerKey = conversationId + ":" + hookId;
    if (input.delegatus_confirm === true) {
      const offer = pendingOffers.get(offerKey);
      const emittedAt = input.delegatus_emitted_at;
      if (offer && typeof emittedAt === "number" && Number.isFinite(emittedAt)
        && emittedAt >= offer.preparedAt && emittedAt < offer.expires && offer.index === memoryIndex()) {
        offer.index.recordInjection(offer.entries, offer.requestId, conversationId);
        pendingOffers.delete(offerKey);
      }
      return "";
    }
    if (!Number.isFinite(remaining) || remaining <= 0 || request.signal.aborted || !viewerReleaseOwnsTraffic()) return "";
    if (typeof input.prompt !== "string" || input.prompt.length > 64000 || typeof input.session_id !== "string"
      || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.session_id) || input.hook_event_name !== "UserPromptSubmit") return "";
    const snapshot = agentRegistry().readOnlySnapshot();
    const conversation = snapshot.conversations[conversationId];
    const generation = conversation?.generations.at(-1);
    const receipt = Object.values(snapshot.receipts).findLast(r => r.conversationId === conversationId);
    const engine = conversation?.engine ?? receipt?.engine;
    if (engine !== "claude" && engine !== "codex") return "";
    if (receipt?.key && receipt.key.sessionId !== input.session_id && !generation?.path.includes(input.session_id)) return "";
    const cwd = generation?.launchProfile.cwd || receipt?.cwd;
    if (!cwd || input.cwd !== cwd) return "";
    const project = conversation?.projectOwnership?.project || projectInfoFromCwd(cwd)?.project;
    if (!project) return "";
    const index = memoryIndex();
    let prompt = input.prompt, origin = "unknown", requestId = "";
    if (engine === "codex") {
      const decoded = decodeCodexStructuredUserText(prompt);
      prompt = decoded.text;
      if (decoded.metadataRef) {
        origin = readStructuredUserMetadata(decoded.metadataRef).origin?.kind ?? "unknown";
        requestId = decoded.metadataRef;
      } else if (decoded.structured) { origin = decoded.origin?.kind ?? "unknown"; requestId = decoded.deliveryDedup ?? ""; }
    } else {
      const ledger = new FileClaudeDeliveryLedger().load(input.session_id);
      if (typeof input.delegatus_delivery_id === "string") {
        const queued = ledger.find(r => r.entry.id === input.delegatus_delivery_id);
        if (!queued || queued.entry.content.text !== prompt) return "";
        origin = queued.entry.origin?.kind ?? "unknown"; requestId = queued.entry.id;
      }
    }
    const transcript = generation?.path ?? receipt?.artifactPath ?? undefined;
    if (!requestId) {
      if (receipt?.transport !== "tmux") return "";
      const nativeId = engine === "claude" ? input.prompt_id : input.turn_id;
      if (typeof nativeId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(nativeId)) return "";
      requestId = `native:${nativeId}`;
      // Consume launch authorship even before its transcript is materialized.
      // A retry of this native id keeps the same receipt; repeated words on a
      // later id do not consume it again.
      origin = index.terminalOrigin(conversationId, requestId, prompt, transcript, engine) ?? "operator";
      const initialOperator = receipt.delegationDepth === 0 && receipt.launchDisplay?.echo === prompt;
      if (origin !== "operator" || (transcript ? !transcript.includes(input.session_id) : !initialOperator)) return "";
      const priorTurns = transcript ? memoryTurnContext(transcript, engine, prompt) : [];
      if (!priorTurns.length && !initialOperator) return "";
      const cursor = transcript ? nativeHookCursor(transcript, engine, nativeId) : { offset: 0, digest: undefined };
      if (cursor.digest && cursor.digest !== messageTextDigest(prompt)) return "";
      // The receipt authenticates an initial launch before scanner settlement.
      // An unknown artifact gets its occurrence join when it materializes.
      index.recordNativeTurn(conversationId, requestId, transcript ?? "", cursor.offset, prompt);
    }
    if (origin !== "operator" || !sharedMemoryEnabled(project)) return "";
    const key = readOpenRouterApiKey();
    if (!key) return "";
    if (performance.now() >= deadline || !index.claimHook(conversationId, requestId)) return "";
    const context = transcript ? memoryTurnContext(transcript, engine as "claude" | "codex", prompt) : [];
    // Recall terms follow the research order within the bounded transcript view.
    const recallQuery = [prompt, ...context.slice().reverse().map(turn => turn.text)].join("\n");
    const latestReply = context.findLast(turn => turn.role === "assistant");
    if (latestReply) index.recordCitations(conversationId, latestReply.citationText ?? latestReply.text);
    let reserved = 0;
    const month = spendMonth(new Date());
    return await injectMemory({ prompt, origin, engine: engine, project, conversation: conversationId, requestId, context }, {
      deadline, signal: request.signal,
      enabled: () => sharedMemoryEnabled(project), ownsTraffic: () => viewerReleaseOwnsTraffic(),
      candidates: deadline => index.injectionCandidates(recallQuery, project, engine, conversationId, deadline),
      reserve: ceiling => {
        mutateOperatorAsks(file => {
          if (file.spend.usd + ceiling > readAsksYouSettings().capUsd) { file.spend.capped++; return; }
          reserved = ceiling; file.spend.usd += ceiling; file.spend.calls++;
        });
        return reserved > 0;
      },
      decide: (body, signal) => decideMemories(body, key, signal),
      settle: cost => { mutateOperatorAsks(file => { if (file.spend.month === month) file.spend.usd += cost - reserved; }); },
      record: entries => {
        if (Date.now() >= expires || request.signal.aborted || pendingOffers.size >= 1024) throw Error("memory delivery evidence unavailable");
        pendingOffers.set(offerKey, { expires, preparedAt: Date.now(), retainUntil: expires + CONFIRMATION_RETENTION_MS, index, requestId, entries });
      },
    });
  } catch { return ""; }
}
