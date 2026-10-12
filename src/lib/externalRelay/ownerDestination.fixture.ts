import { knownRelay } from "./knownRelays";
import type { PairedRelay, RelayTargetSettings } from "./store";

export const destinationTarget = (id: string, ownerTier = false): RelayTargetSettings => ({
  id, name: id, answered_by: "install", fallback: "none", enabled: true, engine: "codex",
  model: "fixture", effort: null, project: "fixture", concurrency: 1, hardCapMinutes: 1, ownerTier,
});
export const destinationRelay = (targets = [destinationTarget("first")]): PairedRelay => ({
  id: "paired", origin: knownRelay("celestia")!.origin, api_base: "https://relay.example/v1", name: "Fixture",
  description: "", credential: "q".repeat(43), owner: { namespace: "telegram", id: "41", display_name: "Owner", handle: null },
  paused: false, pairedAt: "2026-10-11T13:00:00Z", limits: { max_wait_s: 25, max_response_bytes: 1048576, max_answer_chars: 4000 }, targets,
});
