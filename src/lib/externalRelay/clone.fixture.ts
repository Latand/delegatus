import { newTargetSettings, type PairedRelay } from "./store";

/** Invented pairing, usable only by the port-0 test server. */
export function clonePairing(origin: string): PairedRelay {
  return { id: "paired-clone-fixture", origin, api_base: `${origin}/api/relay/v1`, name: "Fixture relay", description: "",
    credential: ["synthetic", "pairing", "credential"].join(" "), pairedAt: "2026-10-20T12:00:00Z", paused: false,
    owner: { namespace: "telegram", id: "700000101", display_name: "Fixture owner", handle: null },
    limits: { max_response_bytes: 1048576, max_wait_s: 30, max_answer_chars: 16384 },
    targets: [newTargetSettings({ target_id: "fixture-clone", name: "Report clone", answered_by: "service", fallback: "none" })] };
}
export const cloneTargets = () => ({ targets: [{ target_id: "fixture-clone", name: "Report clone", active: true,
  chats: [{ chat_id: -1000000000101, title: "Fixture reports" }], chats_next_cursor: null }] });
export const cloneReceipt = (id = 101, replayed = false) => ({ message_id: id, message_key: `fixture_message_${id}`,
  sent_at: "2026-10-20T12:00:00Z", replayed });
