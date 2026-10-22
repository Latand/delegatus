import { agentRegistry, type AgentRegistry } from "@/lib/agent/registry";
import type { ViewerConversationId } from "@/lib/accounts/migration/contracts";
import { hostSupportsTier, type EngineHost, type RuntimeTierCut } from "./engineHost";

/**
 * The in-place tier switch behind Turbo (docs/design/turbo-mode.md §2.6), for
 * a pipeline stage's `in-place` runtime switch and for any other live Codex
 * conversation alike. The live host takes the tier with
 * `thread/settings/update`; the conversation's launch profile records it, so a
 * later resume or restart keeps it. Nothing is released or restarted.
 */

export type TierCutState = "armed" | RuntimeTierCut | "none";

/** Armed and settled cuts by operation, in this process only: a restart loses them and readers see `unknown`. */
const cuts = new Map<string, { conversationId: string; state: TierCutState }>();
const CUT_MEMORY = 512;

function remember(operationId: string, conversationId: string, state: TierCutState): void {
  cuts.delete(operationId);
  cuts.set(operationId, { conversationId, state });
  while (cuts.size > CUT_MEMORY) cuts.delete(cuts.keys().next().value!);
}

export interface TierSwitchDependencies {
  registry?: Pick<AgentRegistry, "conversation" | "deliveryWriteOrBusy" | "updateConversationLaunchProfile">;
  host?: (conversationId: string) => EngineHost | null | Promise<EngineHost | null>;
  authorizeDispatch?: () => void;
  beforeCut?: (turnId: string) => Promise<void>;
  expected?: { accountId: string | null; model: string | null };
}

async function liveHost(conversationId: string): Promise<EngineHost | null> {
  const { structuredDeliveryHostForConversation } = await import("./structuredDeliveryController");
  return structuredDeliveryHostForConversation(conversationId);
}

export async function switchConversationTier(conversationId: string, operationId: string, serviceTier: string | null,
  cut: "boundary" | "none" | "now", dependencies: TierSwitchDependencies = {}): Promise<{ cut: "cut" | "armed" | "none"; appliedTier: string | null; reason?: string }> {
  const registry = dependencies.registry ?? agentRegistry();
  const id = conversationId as ViewerConversationId;
  const before = registry.conversation(id)?.generations.at(-1);
  if (!before) throw new Error("the conversation is no longer registered");
  if (dependencies.expected && (before.accountId !== dependencies.expected.accountId || before.launchProfile.model !== dependencies.expected.model)) {
    throw new Error("the conversation runtime changed after the tier was selected");
  }
  const authorizeDispatch = () => {
    const current = registry.conversation(id)?.generations.at(-1);
    if (!current || current.id !== before.id || current.accountId !== before.accountId || current.launchProfile.model !== before.launchProfile.model) {
      throw new Error("the conversation runtime changed before the tier switch");
    }
    dependencies.authorizeDispatch?.();
  };
  authorizeDispatch();
  const host = await (dependencies.host ?? liveHost)(conversationId);
  if (!hostSupportsTier(host) && (host || cut !== "none")) throw new Error("this conversation's host cannot change its speed in place");
  authorizeDispatch();
  const outcome = hostSupportsTier(host)
    ? await host.setTier({ operationId, serviceTier, cut, authorizeDispatch, beforeCut: dependencies.beforeCut })
    : { appliedTier: serviceTier, cut: "none" as const, settled: undefined, reason: undefined };
  const profile = registry.conversation(id)?.generations.at(-1)?.launchProfile;
  if (profile && registry.conversation(id)?.generations.at(-1)?.id === before.id) {
    await registry.deliveryWriteOrBusy({ label: "turbo.tier", operationId },
      () => {
        const generation = registry.conversation(id)?.generations.at(-1);
        if (generation?.id !== before.id || generation.accountId !== before.accountId || generation.launchProfile.model !== before.launchProfile.model) throw new Error("the conversation generation changed while recording the tier");
        const latest = generation.launchProfile;
        registry.updateConversationLaunchProfile(id, {
          model: latest.model,
          effort: latest.effort,
          fast: outcome.appliedTier === "priority",
          serviceTier: outcome.appliedTier,
        });
      });
  }
  if (outcome.cut === "armed") {
    remember(operationId, conversationId, "armed");
    void outcome.settled?.then(state => { if (cuts.get(operationId)?.state === "armed") remember(operationId, conversationId, state); });
  } else remember(operationId, conversationId, outcome.cut);
  return { cut: outcome.cut, appliedTier: outcome.appliedTier, ...(outcome.reason ? { reason: outcome.reason } : {}) };
}

export function tierCutState(operationId: string, host?: EngineHost | null, turnId?: string): TierCutState | "unknown" {
  return cuts.get(operationId)?.state ?? (turnId && hostSupportsTier(host) ? host.tierCutEvidence?.(turnId) : undefined) ?? "unknown";
}

export async function cancelTierCut(conversationId: string, operationId: string, dependencies: Pick<TierSwitchDependencies, "host"> = {}): Promise<void> {
  const host = await (dependencies.host ?? liveHost)(conversationId);
  const cancelled = hostSupportsTier(host) && host.cancelArmedTierCut(operationId);
  if (cancelled && cuts.get(operationId)?.state === "armed") remember(operationId, conversationId, "cancelled");
}

export function forgetTierCutsForTests(): void { cuts.clear(); }
