import { delegatusMessageOrigin } from "@/lib/runtime/agentMessageAuthor";
import { flowRelayedMessageOccurrences as projectOccurrences, type FlowRelayProvenanceDependencies as ArchiveDependencies } from "@/lib/reviewHistory/relayProvenance";
import { loadFlows } from "./store";

/** Compatibility adapter until the read-only archive reader replaces the live store. */
export type FlowRelayProvenanceDependencies = Partial<ArchiveDependencies>;
export function flowRelayedMessageOccurrences(transcriptPath: string, dependencies: FlowRelayProvenanceDependencies = {}) {
  return projectOccurrences(transcriptPath, {
    ...dependencies,
    flows: dependencies.flows ?? loadFlows,
    senderProject: dependencies.senderProject ?? ((flow) => delegatusMessageOrigin("reviewer", flow.project, flow.cwd).project),
  });
}
