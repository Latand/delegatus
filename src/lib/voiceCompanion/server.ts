import { CompanionStorage } from "./storage";
import { CompanionAdmission } from "./admission";
import { companionDeliveryPaths } from "./deliveryPaths";
import { CompanionBoardReads } from "./boardReads";
import { companionBoardReadPaths } from "./readPaths";
import { OpenAILiveProvider } from "./provider";
import { CodexLiveProvider } from "./codexProvider";
import { CompanionLiveSessions } from "./liveSession";

const globals = globalThis as typeof globalThis & { __delegatusVoiceSessions?: CompanionLiveSessions };
export function companionSessions(): CompanionLiveSessions {
  return globals.__delegatusVoiceSessions ??= (() => {
    const storage = new CompanionStorage();
    // The settings choose each new call's backend: the API with its key (the
    // default), or Codex V3 on a managed account's plan.
    const service = new CompanionLiveSessions(storage, new CompanionAdmission(storage, companionDeliveryPaths), new CompanionBoardReads(companionBoardReadPaths),
      new OpenAILiveProvider(), { codexProvider: new CodexLiveProvider() });
    // A session a previous Viewer minted has no owner here. Close it at once; no browser has to ask for it.
    void service.recover().catch(() => undefined);
    return service;
  })();
}
export function setCompanionSessionsForTests(value: CompanionLiveSessions | undefined): void { globals.__delegatusVoiceSessions = value; }
