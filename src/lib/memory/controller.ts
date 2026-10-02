import { callerConversationId } from "@/lib/agent/operatorAuthority";
import { agentRegistry } from "@/lib/agent/registry";
import { readAsksYouSettings, readOpenRouterApiKey } from "@/lib/asks/settings";
import { mutateOperatorAsks, spendMonth } from "@/lib/asks/store";
import { projectInfoFromCwd } from "@/lib/scanner/describe";
import { decodeCodexStructuredUserText } from "@/lib/runtime/codexStructuredUserText";
import { FileClaudeDeliveryLedger } from "@/lib/runtime/claudeStreamBrokerHost";
import { readStructuredUserMetadata } from "@/lib/selection/structuredUserMetadata";
import { viewerReleaseOwnsTraffic } from "@/lib/viewerInstrumentation";
import { memoryTurnContext } from "./context";
import { decideMemories, injectMemory } from "./injection";
import { memoryIndex } from "./service";
import { sharedMemoryEnabled } from "./settings";

export async function offerForHook(request: Request, input: Record<string, unknown>): Promise<string> {
  const deadline = performance.now() + 1500;
  try {
    if (typeof input.prompt !== "string" || input.prompt.length > 64000 || typeof input.session_id !== "string"
      || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.session_id) || input.hook_event_name !== "UserPromptSubmit") return "";
    const conversationId = callerConversationId(request);
    if (!conversationId || !viewerReleaseOwnsTraffic()) return "";
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
    if (!project || !sharedMemoryEnabled(project)) return "";
    const key = readOpenRouterApiKey();
    if (!key) return "";
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
    const transcript = generation?.path;
    if (!requestId) {
      // Unmarked terminal input is admitted only on an already bound native session.
      if (receipt?.transport !== "tmux" || !transcript || !transcript.includes(input.session_id)) return "";
      const priorTurns = memoryTurnContext(transcript, engine, prompt);
      if (!priorTurns.length && !(receipt?.delegationDepth === 0 && receipt.launchDisplay?.echo === prompt)) return "";
      origin = "operator";
      const nativeId = engine === "claude" ? input.prompt_id : input.turn_id;
      if (typeof nativeId !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(nativeId)) return "";
      requestId = `native:${nativeId}`;
    }
    if (origin !== "operator") return "";
    if (performance.now() >= deadline || !index.claimHook(conversationId, requestId)) return "";
    const context = transcript ? memoryTurnContext(transcript, engine as "claude" | "codex", prompt) : [];
    const latestReply = context.findLast(turn => turn.role === "assistant");
    if (latestReply) index.recordCitations(conversationId, latestReply.text);
    let reserved = 0;
    const month = spendMonth(new Date());
    return await injectMemory({ prompt, origin, engine: engine, project, conversation: conversationId, requestId, context }, {
      deadline,
      enabled: () => sharedMemoryEnabled(project), ownsTraffic: () => viewerReleaseOwnsTraffic(),
      candidates: deadline => index.injectionCandidates(prompt, project, engine, conversationId, deadline),
      reserve: ceiling => {
        mutateOperatorAsks(file => {
          if (file.spend.usd + ceiling > readAsksYouSettings().capUsd) { file.spend.capped++; return; }
          reserved = ceiling; file.spend.usd += ceiling; file.spend.calls++;
        });
        return reserved > 0;
      },
      decide: (body, signal) => decideMemories(body, key, signal),
      settle: cost => { mutateOperatorAsks(file => { if (file.spend.month === month) file.spend.usd += cost - reserved; }); },
      record: entries => index.recordInjection(entries, requestId, conversationId),
    });
  } catch { return ""; }
}
