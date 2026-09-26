import type { LaunchRuntime } from "@/lib/roles/sizing";

import type { RegistryFile } from "./registry";

/**
 * The runtime a registered conversation runs on: its engine and its newest
 * generation's launch model (a null model is the engine default). Null when
 * the registry does not know the conversation. This is how a launch seam
 * judges the agent that wrote a brief (docs/design/model-sizing-tiers.md §2).
 */
export function conversationRuntime(
  file: Pick<RegistryFile, "conversations">,
  conversationId: string | null | undefined,
): LaunchRuntime | null {
  if (!conversationId) return null;
  const conversation = file.conversations[conversationId];
  if (!conversation) return null;
  return { engine: conversation.engine, model: conversation.generations.at(-1)?.launchProfile.model ?? null };
}
