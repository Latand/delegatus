import type { AgentRegistry } from "@/lib/agent/registry";
import { deliverConversationMessage, migrationDeliveryOutcome, type DeliveryOverrides } from "@/lib/delivery";
import { ownedDeliveryProgressStore } from "@/lib/runtime/deliveryProgress";
import { recordObservedWait, recordWait, type DeliveryProgressPort } from "@/lib/runtime/recordWait";
import {
  deliverHeldStructuredMessage,
  type HeldStructuredMessageOutcome,
} from "@/lib/runtime/structuredMessageDelivery";

import type { HeldDeliveryPort } from "./coordinator";

type HeldDeliveryInput = Parameters<HeldDeliveryPort["deliver"]>[0];

export interface MigrationDeliveryPortDependencies {
  structuredDelivery?: typeof deliverHeldStructuredMessage;
  legacyDelivery?: (input: HeldDeliveryInput) => Promise<Exclude<HeldStructuredMessageOutcome, null> | "held">;
  /** Where the drain's own waits are recorded; the Viewer's store by default. */
  progress?: DeliveryProgressPort | null;
  /** The legacy ladder's transports, for tests that drive the real legacy drain. */
  legacyOverrides?: DeliveryOverrides;
}

export function createMigrationDeliveryPort(
  dependencies: MigrationDeliveryPortDependencies = {},
): HeldDeliveryPort {
  const structuredDelivery = dependencies.structuredDelivery ?? deliverHeldStructuredMessage;
  const progress = () => dependencies.progress === undefined ? ownedDeliveryProgressStore() : dependencies.progress;
  const legacyDelivery = dependencies.legacyDelivery ?? (async ({ delivery, path, clientMessageId, lease }) => {
    if (delivery.payloadKind === "runtime-images") return "delivery-uncertain";
    const result = await deliverConversationMessage({
      pid: null,
      path,
      text: delivery.text,
      images: [],
      clientMessageId,
      reservedDeliveryId: delivery.id,
      /* #1117: the authorship persisted on the held command replays with the
         message, so a re-routed hold re-attributes exactly as admitted. */
      ...(delivery.command.origin ? { origin: delivery.command.origin } : {}),
    }, {
      ...dependencies.legacyOverrides,
      ...(dependencies.progress !== undefined ? { progress: dependencies.progress } : {}),
      ...(lease ? { actuationLease: lease } : {}),
    });
    return migrationDeliveryOutcome(result);
  });
  const deliverStructured = ({ delivery, path, clientMessageId }: HeldDeliveryInput, reconcileUncertain = false) => structuredDelivery({
    conversationId: delivery.conversationId,
    runtimeConversationId: delivery.runtimeConversationId,
    path,
    deliveryId: delivery.id,
    clientMessageId,
    text: delivery.text,
    command: delivery.command,
    ...(reconcileUncertain ? { reconcileUncertain: true } : {}),
    ...(delivery.runtimeImages.length ? { imageRefs: delivery.runtimeImages } : {}),
  }, dependencies.progress !== undefined ? { progress: dependencies.progress } : {});
  return {
    async deliver(input) {
      const outcome = await deliverStructured(input);
      return outcome ?? legacyDelivery(input);
    },
    async reconcileUncertain(input) {
      return await deliverStructured(input, true) ?? "delivery-uncertain";
    },
    wait({ delivery, registry, reason, detail = null, observer = false }: {
      delivery: HeldDeliveryInput["delivery"];
      registry: AgentRegistry;
      reason: Parameters<typeof recordWait>[3]["reason"];
      detail?: string | null;
      observer?: boolean;
    }) {
      if (observer) recordObservedWait(progress(), registry, delivery, detail ?? "an earlier delivery on this conversation is still in progress");
      else recordWait(progress(), registry, delivery, { reason, detail });
    },
  };
}
