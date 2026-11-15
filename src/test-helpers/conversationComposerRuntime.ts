import type { RuntimeReceipt } from "@/components/runtime/runtimeModel";
import type { RuntimeSessionView } from "@/hooks/useRuntime";
import { setRuntimeUiEnabledForTests } from "@/hooks/runtimeBus";
import type { FileEntry } from "@/lib/types";
import { setConversationComposerRuntimeDependenciesForTests } from "@/components/conversationComposerRuntime";
import { agentCapabilitiesFromViews } from "@/components/useAgentCapabilities";

type RuntimeViewHook = (file: FileEntry) => RuntimeSessionView | null;
type RuntimeReceiptsHook = (path: string | null, conversationId?: string | null) => RuntimeReceipt[];

export function installConversationComposerRuntimeForTests({
  useRuntimeView,
  runtimeEnabled,
  useRuntimeReceipts = () => [],
  refreshRuntime,
}: {
  useRuntimeView: RuntimeViewHook;
  runtimeEnabled?: boolean | ((file: FileEntry, view: RuntimeSessionView | null) => boolean);
  useRuntimeReceipts?: RuntimeReceiptsHook;
  refreshRuntime?: () => Promise<boolean>;
}): void {
  setRuntimeUiEnabledForTests(false);
  setConversationComposerRuntimeDependenciesForTests({
    useAgentCapabilities: (file) => {
      const view = useRuntimeView(file);
      const enabled = typeof runtimeEnabled === "function"
        ? runtimeEnabled(file, view)
        : runtimeEnabled ?? (view !== null);
      return agentCapabilitiesFromViews(file, view, null, enabled);
    },
    useRuntimeReceiptsForArtifact: useRuntimeReceipts,
    ...(refreshRuntime ? { refreshRuntime } : {}),
  });
}

export function resetConversationComposerRuntimeForTests(): void {
  setConversationComposerRuntimeDependenciesForTests(null);
  setRuntimeUiEnabledForTests(null);
}
