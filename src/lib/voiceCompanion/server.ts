import { CallMemory } from "./callMemory";
import { CompanionStorage } from "./storage";
import { CompanionAdmission } from "./admission";
import { companionDeliveryPaths } from "./deliveryPaths";
import { CompanionBoardReads } from "./boardReads";
import { companionBoardReadPaths } from "./readPaths";
import { OpenAILiveProvider } from "./provider";
import { CodexLiveProvider } from "./codexProvider";
import { CompanionLiveSessions } from "./liveSession";
import { voiceToolSessions } from "@/lib/voiceTools/sessions";
import { existingTeamStore } from "@/lib/team/store";

const globals = globalThis as typeof globalThis & { __delegatusVoiceSessions?: CompanionLiveSessions };
export function companionSessions(): CompanionLiveSessions {
  return globals.__delegatusVoiceSessions ??= (() => {
    const storage = new CompanionStorage();
    // The settings choose each new call's backend: the API with its key (the
    // default), or Codex V3 on a managed account's plan.
    const admission = new CompanionAdmission(storage, companionDeliveryPaths);
    const service = new CompanionLiveSessions(storage, admission, new CompanionBoardReads(companionBoardReadPaths),
      new OpenAILiveProvider(), { codexProvider: new CodexLiveProvider(), memory: new CallMemory(storage, admission.records),
        // Added servers belong to the owner in v1: a member's call takes them only as the active team owner.
        voiceTools: voiceToolSessions(memberId => { const member = existingTeamStore()?.member(memberId); return member?.role === "owner" && member.status === "active"; }) });
    // A session a previous Viewer minted has no owner here. Close it at once; no browser has to ask for it.
    void service.recover().catch(() => undefined);
    return service;
  })();
}
export function setCompanionSessionsForTests(value: CompanionLiveSessions | undefined): void { globals.__delegatusVoiceSessions = value; }
