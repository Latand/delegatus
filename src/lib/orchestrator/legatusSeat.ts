import { ensureSelf, readSelf } from "@/lib/links/self";
import { legatusProjectKey } from "@/lib/projects/serviceProject";
import { orchestratorSeatFor } from "./seats";

export function localLegatusProject(): string | null {
  const self = readSelf();
  return self?.installId ? legatusProjectKey(self.installId) : null;
}

/** The explicit designation flow uses this when the install has never linked. */
export function ensureLegatusProject(): string {
  const self = ensureSelf();
  if (!self?.installId) throw new Error("local installation identity is unavailable");
  return legatusProjectKey(self.installId);
}

export function currentLegatusSeat(conversationId: string | null) {
  if (!conversationId) return null;
  const project = localLegatusProject();
  const seat = project ? orchestratorSeatFor(project).active : null;
  return seat?.conversationId === conversationId ? seat : null;
}
