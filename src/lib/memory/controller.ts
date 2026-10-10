import { structuredContent } from "@/lib/runtime/structuredContent";
import { messageTextDigest } from "@/lib/runtime/messageTextDigest";
import { callerConversationId } from "@/lib/agent/operatorAuthority";
import { agentRegistry } from "@/lib/agent/registry";
import { readAsksYouSettings, readOpenRouterApiKey } from "@/lib/asks/settings";
import { mutateOperatorAsks, spendMonth } from "@/lib/asks/store";
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import { decodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText";
import { deliveryDedupToken } from "@/lib/runtime/deliveryDedup";
import { FileClaudeDeliveryLedger } from "@/lib/runtime/claudeStreamBrokerHost";
import { readStructuredUserMetadata } from "@/lib/selection/structuredUserMetadata";
import { viewerReleaseOwnsTraffic } from "@/lib/viewerInstrumentation";
import { nativeHookCursor } from "./native";
import { memoryTurnContext } from "./context";
import { decideMemories, injectMemory } from "./injection";
import { memoryIndex } from "./service";
import type { MemoryTurnReason } from "./viewTypes";
import { sharedMemoryEnabled } from "./settings";
import { conversationMemoryExcluded } from "./eligibility";
// Selected names are provisional durable evidence until stdout confirmation;
// selection expiry and bounded confirmation retention are separate deadlines.
export async function offerForHook(request: Request, input: Record<string, unknown>): Promise<string> {
  const expires = Math.min(Number(request.headers.get("x-llv-memory-deadline")), Date.now() + 1500);
  const hookId = request.headers.get("x-llv-memory-hook") ?? "";
  const remaining = Math.min(1500, expires - Date.now());
  const deadline = performance.now() + remaining;
  const startedAt = performance.timeOrigin + performance.now();
  let lastTurn: { project: string; conversation: string; request: string } | undefined;
  let reason: MemoryTurnReason = "invalidTurn";
  let candidateReason: MemoryTurnReason | undefined;
  let counted = input.delegatus_confirm === true;
  let possibleOperator = false;
  let outcome: "skipped" | "failed" = "skipped";
  try {
    if (!/^[a-f0-9-]{36}$/.test(hookId)) return "";
    const conversationId = callerConversationId(request);
    if (!conversationId) return "";
    if (input.delegatus_confirm === true) {
      if (typeof input.delegatus_emitted_at === "number") memoryIndex().confirmPreparedInjection(conversationId, hookId, input.delegatus_emitted_at);
      return "";
    }
    possibleOperator = true;
    if (typeof input.prompt !== "string" || input.prompt.length > 64000 || typeof input.session_id !== "string"
      || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.session_id) || input.hook_event_name !== "UserPromptSubmit") return "";
    const snapshot = agentRegistry().readOnlySnapshot();
    const conversation = snapshot.conversations[conversationId];
    const generation = conversation?.generations.at(-1);
    const receipt = Object.values(snapshot.receipts).findLast(r => r.conversationId === conversationId);
    const engine = conversation?.engine ?? receipt?.engine;
    if (engine !== "claude" && engine !== "codex") return "";
    // A clean stage (a reviewer, a review gate) takes no automatic memory on any turn.
    if (conversationMemoryExcluded({ agentRole: conversation?.agentRole ?? receipt?.agentRole, launchProfile: generation?.launchProfile ?? receipt?.launchProfile })) {
      possibleOperator = false; return "";
    }
    if (receipt?.key && receipt.key.sessionId !== input.session_id && !generation?.path.includes(input.session_id)) return "";
    const cwd = generation?.launchProfile.cwd || receipt?.cwd;
    if (!cwd || input.cwd !== cwd) return "";
    const project = conversation?.projectOwnership?.project || projectInfoFromCwd(cwd)?.project;
    if (!project) return "";
    lastTurn = { project, conversation: conversationId, request: hookId };
    reason = "unprovenOrigin";
    const index = memoryIndex();
    let prompt = input.prompt, origin = "unknown", requestId = "", deliveryKey = "";
    if (engine === "codex") {
      const decoded = decodeCodexStructuredUserText(prompt);
      prompt = decoded.text;
      if (decoded.metadataRef) {
        const metadata = readStructuredUserMetadata(decoded.metadataRef);
        origin = metadata.origin?.kind ?? "unknown";
        deliveryKey = metadata.deliveryDedup ?? "";
        requestId = decoded.metadataRef;
      } else if (decoded.structured) { origin = decoded.origin?.kind ?? "unknown"; requestId = deliveryKey = decoded.deliveryDedup ?? ""; }
    } else {
      const ledger = new FileClaudeDeliveryLedger().load(input.session_id);
      if (typeof input.delegatus_delivery_id === "string") {
        const queued = ledger.find(r => r.entry.id === input.delegatus_delivery_id);
        if (!queued || queued.entry.content.text !== prompt) return "";
        origin = queued.entry.origin?.kind ?? "unknown"; requestId = queued.entry.id;
      }
    }
    // A launch brief is delivered with operator origin whatever started it.
    // The receipt names the initiator: a launching conversation, a container
    // membership, a delegated depth or a board maintenance run. Drafts from
    // the new-agent form carry none of them, with or without a role or parent.
    // Later human messages in the same conversation remain eligible.
    const delivery = deliveryKey ? Object.values(snapshot.deliveryOperationOwners).find(owner =>
      owner.conversationId === conversationId && deliveryDedupToken(owner.command.operationId) === deliveryKey) : undefined;
    if (delivery?.command.origin?.kind === "agent") { possibleOperator = false; return ""; }
    const humanSubmission = delivery?.command.origin?.kind === "operator" && !delivery.command.operationId.startsWith("spawn_message_");
    const containerLaunch = snapshot.memberships[conversationId]?.some(entry => entry.kind === "pipeline" || entry.kind === "flow");
    if (!humanSubmission && receipt?.launchDisplay?.echo === prompt && (containerLaunch || (receipt.delegationDepth ?? 0) > 0
      || receipt.launcher || receipt.clientAttemptId?.startsWith("maint_"))) {
      possibleOperator = false; return "";
    }
    if (requestId && origin !== "operator") { possibleOperator = origin === "unknown"; return ""; }
    const transcript = generation?.path ?? receipt?.artifactPath ?? undefined;
    if (!requestId) {
      if (receipt?.transport !== "tmux") return "";
      if (engine === "claude" && input.source !== undefined && input.source !== "user") { possibleOperator = false; return ""; }
      const nativeId = engine === "claude" ? input.prompt_id : input.turn_id;
      if (typeof nativeId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(nativeId)) return "";
      requestId = `native:${nativeId}`;
      // Consume launch authorship even before its transcript is materialized.
      // A retry of this native id keeps the same receipt; repeated words on a
      // later id do not consume it again.
      const terminalOrigin = index.terminalOrigin(conversationId, requestId, prompt, transcript, engine);
      if (terminalOrigin && terminalOrigin !== "operator" && terminalOrigin !== "unknown") { possibleOperator = false; return ""; }
      if (!index.nativeOperatorOwned(conversationId, requestId, prompt)) {
        // Delivery can proceed after both optional receipt stores fail. The
        // registry reservation predates transport and survives reload; without
        // its matching receipt, native authorship remains unproven. Explicit
        // structured operator metadata above needs no such inference.
        const owners = Object.values(snapshot.deliveryOperationOwners);
        const ownerCounts = new Map<string, number>();
        for (const owner of owners) ownerCounts.set(owner.conversationId, (ownerCounts.get(owner.conversationId) ?? 0) + 1);
        const evidence = new Map(owners.filter(owner => owner.terminalDisposition !== "lost").map(owner => [owner.command.operationId, { conversationId: owner.conversationId, command: owner.command, contentDigest: owner.contentDigest, payloadKind: "unknown" }]));
        for (const held of Object.values(snapshot.heldDeliveries)) if (snapshot.deliveryOperationOwners[held.command.operationId]?.terminalDisposition !== "lost") evidence.set(held.command.operationId, held);
        // At the owner's retention bound, absence no longer proves that this
        // native input lacks a machine sender. Compaction markers survive it.
        const incompleteHistory = !!snapshot.deliveryEvidenceCompactions[conversationId] || (ownerCounts.get(conversationId) ?? 0) >= 200;
        const contentDigest = structuredContent(prompt, []).contentDigest;
        const missingMachineReceipt = [...evidence.values()].some(delivery =>
          delivery.conversationId === conversationId && delivery.command.origin?.kind !== "operator"
          && (delivery.contentDigest === contentDigest || delivery.payloadKind !== "text")
          && !index.hasTerminalDelivery(delivery.command.operationId));
        const relay = prompt.match(/^User message for your branch «[^\n]*» — forward it or handle it yourself:\n([\s\S]*)$/);
        const relayDigest = relay ? structuredContent(relay[1], []).contentDigest : null;
        // A relay reservation belongs to its child conversation, while its
        // terminal receipt belongs to the root. Every matching source delivery
        // must have evidence; a prior same-text relay cannot cover a lost one.
        const missingRelayReceipt = relay && (Object.keys(snapshot.deliveryEvidenceCompactions).length > 0
          || [...ownerCounts.values()].some(count => count >= 200) || !index.hasTerminalPrompt(conversationId, prompt)
          || [...evidence.values()].some(delivery =>
            (delivery.contentDigest === relayDigest || delivery.payloadKind !== "text")
            && !index.hasTerminalDelivery(delivery.command.operationId)));
        const missingLaunchReceipt = (receipt.delegationDepth ?? 1) > 0 && !index.hasTerminalDelivery(`spawn:${receipt.launchId}`);
        if (incompleteHistory || missingMachineReceipt || missingLaunchReceipt || missingRelayReceipt) return "";
      }
      origin = terminalOrigin ?? "operator";
      const initialOperator = receipt.delegationDepth === 0 && receipt.launchDisplay?.echo === prompt;
      if (origin !== "operator" || (transcript ? !transcript.includes(input.session_id) : !initialOperator)) return "";
      const priorTurns = transcript ? memoryTurnContext(transcript, engine, prompt, conversationId) : [];
      if (!priorTurns.length && !initialOperator) return "";
      const cursor = transcript ? nativeHookCursor(transcript, engine, nativeId) : { offset: 0, digest: undefined };
      if (cursor.digest && cursor.digest !== messageTextDigest(prompt)) return "";
      // The receipt authenticates an initial launch before scanner settlement.
      // An unknown artifact gets its occurrence join when it materializes.
      index.recordNativeTurn(conversationId, requestId, transcript ?? "", cursor.offset, prompt);
    }
    if (origin !== "operator") { possibleOperator = false; return ""; }
    lastTurn.request = requestId;
    if (!Number.isFinite(remaining) || remaining <= 0) { reason = "timeout"; return ""; }
    if (request.signal.aborted) { reason = "cancelled"; return ""; }
    if (!viewerReleaseOwnsTraffic()) { reason = "notOwner"; return ""; }
    if (!sharedMemoryEnabled(project)) { reason = "projectOff"; return ""; }
    const key = readOpenRouterApiKey();
    if (!key) { reason = "noKey"; return ""; }
    if (performance.now() >= deadline) { reason = "timeout"; return ""; }
    if (!index.claimHook(conversationId, requestId)) { possibleOperator = false; return ""; }
    const context = transcript ? memoryTurnContext(transcript, engine as "claude" | "codex", prompt, conversationId) : [];
    // Recall terms follow the research order within the bounded transcript view.
    const recallQuery = [prompt, ...context.slice().reverse().map(turn => turn.text)].join("\n");
    const latestReply = context.findLast(turn => turn.role === "assistant");
    if (latestReply) index.recordCitations(conversationId, latestReply.citationText ?? latestReply.text);
    let reserved = 0;
    const month = spendMonth(new Date());
    counted = true;
    return await injectMemory({ prompt, origin, engine: engine, project, conversation: conversationId, requestId, context }, {
      deadline, signal: request.signal,
      activity: event => { try { index.recordInjectionActivity(event); if (event === "noMatches") index.recordUnmatchedTurn(conversationId, requestId); } catch { /* optional ledger */ } },
      enabled: () => sharedMemoryEnabled(project), ownsTraffic: () => viewerReleaseOwnsTraffic(),
      reason: value => { reason = value === "noCandidates" && candidateReason ? candidateReason : value; },
      candidates: deadline => index.injectionCandidates(recallQuery, project, engine, conversationId, deadline, { cwd, reason: value => { candidateReason = value; } }),
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
        if (Date.now() >= expires || request.signal.aborted) throw Error("memory delivery evidence unavailable");
        index.recordPreparedInjection(entries, requestId, conversationId, hookId, expires);
      },
    });
  } catch { outcome = "failed"; reason = "failed"; return ""; }
  finally {
    if (possibleOperator && lastTurn) { try { memoryIndex().recordLastTurn(lastTurn.project, lastTurn.conversation, lastTurn.request, startedAt, reason, expires); } catch { /* optional status */ } }
    if (possibleOperator && !counted) { try { memoryIndex().recordInjectionActivity(outcome); } catch { /* optional ledger */ } }
  }
}
