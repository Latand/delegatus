import type { AgentEngine } from "@/lib/agent/cli";
import { codexModelSupportsImages } from "@/lib/agent/models";
import {
  runtimeEventsEnabled,
  runtimeEventsRolledBack,
  runtimeHostSocket,
  runtimeUiEnabled,
  structuredHostsEnabled,
} from "./flags";
import { CODEX_STRUCTURED_IMAGE_REASON } from "./structuredContent";

export type SpawnTransport = "structured";

/** Every agent is hosted by a structured host. `LLV_SPAWN_TRANSPORT` is still
    read so an installation that names the retired terminal transport, or
    anything else, is told so at the first spawn. A deployment with no runtime
    host gets the gap {@link structuredSpawnGap} names. */
export function spawnTransport(env: Readonly<Record<string, string | undefined>> = process.env): SpawnTransport {
  const requested = env.LLV_SPAWN_TRANSPORT?.trim();
  if (requested && requested !== "structured") {
    throw new Error("LLV_SPAWN_TRANSPORT must be structured; the terminal transport was removed");
  }
  return "structured";
}

/** Whether a dead conversation can be given a new structured host here. A
    deployment with a rollback switch thrown, or with no runtime events plane,
    has nothing to host it; an explicit `LLV_SPAWN_TRANSPORT=structured`
    states that the deployment hosts agents and is taken at its word. */
export function structuredTransportAvailable(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  if (env.LLV_SPAWN_TRANSPORT?.trim() === "structured") return true;
  return structuredHostsEnabled(env) && runtimeEventsEnabled(env) && runtimeUiEnabled(env);
}

export function structuredSpawnGap(
  request: { engine: AgentEngine; model: string | null; hasImages: boolean },
  env: Readonly<Record<string, string | undefined>> = process.env,
): string | null {
  if (!structuredHostsEnabled(env)) return "structured spawn is rolled back by LLV_STRUCTURED_HOSTS=0";
  if (runtimeEventsRolledBack(env)) return "structured spawn is rolled back by LLV_RUNTIME_EVENTS=0";
  if (!runtimeHostSocket(env)) return "structured spawn requires a runtime host socket (LLV_RUNTIME_HOST_SOCKET)";
  if (!runtimeUiEnabled(env)) return "structured spawn requires the runtime UI (NEXT_PUBLIC_RUNTIME_UI=0 removes the viewer controls)";
  if (request.hasImages && request.engine === "codex" && !codexModelSupportsImages(request.model)) {
    return CODEX_STRUCTURED_IMAGE_REASON;
  }
  return null;
}
