import { CompanionStorage } from "./storage";
import { CompanionAdmission } from "./admission";
import { companionDeliveryPaths } from "./deliveryPaths";
import { CompanionBoardReads } from "./boardReads";
import { companionBoardReadPaths } from "./readPaths";
import { OpenAILiveProvider } from "./provider";
import { CompanionLiveSessions } from "./liveSession";

const globals = globalThis as typeof globalThis & { __delegatusVoiceSessions?: CompanionLiveSessions };
export function companionSessions(): CompanionLiveSessions {
  return globals.__delegatusVoiceSessions ??= (() => {
    const storage = new CompanionStorage();
    return new CompanionLiveSessions(storage, new CompanionAdmission(storage, companionDeliveryPaths), new CompanionBoardReads(companionBoardReadPaths), new OpenAILiveProvider());
  })();
}
export function setCompanionSessionsForTests(value: CompanionLiveSessions | undefined): void { globals.__delegatusVoiceSessions = value; }
