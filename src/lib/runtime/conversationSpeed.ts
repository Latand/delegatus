import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import { listCodexAccounts } from "@/lib/accounts/codex";
import { codexModelServiceTiers, codexServiceTierRefusal, SERVICE_TIER_PATTERN } from "@/lib/accounts/codexServiceTiers";
import { conversationProjectKey } from "@/lib/accounts/conversationProject";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { readTurboSettings, updateTurboEpisode } from "@/lib/monitor/seatTickSettings";
import { turboActive } from "@/lib/monitor/turbo";
import { waitForStateLock } from "@/lib/state/lockWait";
import { headCwd } from "@/lib/agent/transcript";
import { newOperationId } from "./contracts";
import { structuredDeliveryHostForConversation } from "./structuredDeliveryController";
import { switchConversationTier, type TierSwitchDependencies } from "./tierSwitch";

export type ConversationSpeedResult = { status: number; body: {
  ok?: boolean; error?: string; code?: string; operationId?: string;
  requestedTier?: string; appliedTier?: string | null; echoed?: boolean; reason?: string;
} };

class SpeedRefusal extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

/** Speed is a thread profile update. It never releases a host or cuts a turn. */
export async function changeConversationSpeed(conversationId: string, serviceTier: unknown, operationId = newOperationId(),
  dependencies: { registry?: AgentRegistry; accounts?: typeof listCodexAccounts; host?: TierSwitchDependencies["host"] } = {}): Promise<ConversationSpeedResult> {
  if (typeof serviceTier !== "string" || !SERVICE_TIER_PATTERN.test(serviceTier)) {
    return { status: 400, body: { error: "speed needs a catalog serviceTier id", code: "invalid_service_tier" } };
  }
  const requestedTier = serviceTier === "standard" ? "default" : serviceTier;
  const registry = dependencies.registry ?? agentRegistry();
  const id = conversationId as ViewerConversationId;
  const guard = () => {
    const conversation = registry.conversation(id);
    const generation = conversation?.generations.at(-1);
    if (!conversation || !generation) throw new SpeedRefusal(409, "conversation_unavailable", "the conversation is no longer registered");
    if (conversation.engine !== "codex") throw new SpeedRefusal(400, "codex_only", "speed is Codex only");
    if (registry.conversationMemberships(id).some(row => row.kind === "pipeline")) {
      throw new SpeedRefusal(409, "stage_bound", "a pipeline stage changes speed through its stage runtime switch");
    }
    if (conversation.reconfigure?.status === "applying" || conversation.switchHold
      || conversation.migration && !["committed", "rolled-back"].includes(conversation.migration.phase)) {
      throw new SpeedRefusal(409, "runtime_change_in_flight", "a runtime change is already in flight");
    }
    const key = { engine: conversation.engine, sessionId: generation.id };
    const entry = registry.startupHostSnapshot(key).entries[`${key.engine}:${key.sessionId}`];
    if (entry?.host) throw new SpeedRefusal(409, "tier_change_failed", "this conversation's host cannot change its speed in place");
    const model = generation.launchProfile.model;
    if (!model) throw new SpeedRefusal(409, "model_unknown", "the conversation's model is unknown");
    const account = (dependencies.accounts ?? listCodexAccounts)().find(account => account.id === generation.accountId);
    if (!account || requestedTier !== "default" && !codexModelServiceTiers(account.home, model)?.some(tier => tier.id === requestedTier)) {
      throw new SpeedRefusal(409, "service_tier_unavailable", codexServiceTierRefusal(account ? [account] : [], model, requestedTier, generation.accountId));
    }
    return { conversation, generation, model };
  };
  try {
    const before = guard();
    let hosted = false;
    const outcome = await switchConversationTier(id, operationId, requestedTier, "none", {
      registry, writeLabel: "conversation.tier",
      expected: { accountId: before.generation.accountId, model: before.model },
      authorizeDispatch: () => { guard(); },
      host: async id => {
        const host = await (dependencies.host ?? structuredDeliveryHostForConversation)(id);
        hosted = !!host;
        return host;
      },
    });
    const project = conversationProjectKey(before.conversation.projectOwnership, before.generation.launchProfile, { get cwd() { return headCwd(before.generation.path); } });
    if (project) {
      await waitForStateLock("conversation.tier.turbo", () => {
        const turbo = readTurboSettings(project).turbo;
        if (!turboActive(turbo, Date.now()) || !turbo) return;
        updateTurboEpisode(project, turbo.startedAt, episode => ({ ...episode, switches: episode.switches.map(row =>
          row.conversationId === id && row.accountId === before.generation.accountId && row.model === before.model && !["reverted", "skipped", "failed"].includes(row.state)
            ? { ...row, from: outcome.appliedTier } : row) }));
      });
    }
    const differs = outcome.appliedTier !== requestedTier;
    return { status: differs ? 409 : 200, body: {
      ok: !differs, operationId, requestedTier, appliedTier: outcome.appliedTier, echoed: outcome.echoed,
      ...(differs ? { code: "tier_differs", error: outcome.reason ?? "the native tier differs from the requested tier" } : {}),
      ...(outcome.reason ? { reason: outcome.reason } : !hosted ? { reason: "the tier applies at the next resume" } : {}),
    } };
  } catch (error) {
    return { status: error instanceof SpeedRefusal ? error.status : 409,
      body: { ok: false, operationId, requestedTier, code: error instanceof SpeedRefusal ? error.code : "tier_change_failed",
        error: error instanceof Error ? error.message : String(error) } };
  }
}
