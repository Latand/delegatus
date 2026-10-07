import fs from "node:fs";
import path from "node:path";

const fixtureDir = path.join(import.meta.dir, "fixtures/service-wire");
export const serviceClaims = fs.readdirSync(fixtureDir)
  .filter((name) => /^claimed_.*\.json$/.test(name))
  .sort()
  .map((name) => ({ name, body: JSON.parse(fs.readFileSync(path.join(fixtureDir, name), "utf8")) }));
export const sampleRequest = {
  request_id: "rq_1",
  lease_id: "ls_Zq3vN8bY1xKp4LmT0aW9rE",
  kind: "answer",
  target_id: "target_1",
  claimed_at: "2026-09-28T12:00:01Z",
  liveness: {
    poll_freshness_s: 60,
    claim_window_s: 5,
    ack_window_s: 10,
    heartbeat_interval_s: 10,
    stall_window_s: 45,
  },
  input: {
    instructions: "Answer briefly",
    owner_instructions: null,
    documents: [],
    conversation: [
      {
        id: "m1",
        author: { key: "u1", name: "User", self: false },
        sent_at: "2026-09-28T12:00:00Z",
        text: "Hello",
        reply_to: null,
      },
    ],
    respond_to: "m1",
    request_text: null,
  },
  answer: { max_chars: 20, progress: "notes" },
} as const;
/** The same request with requester_context (§A.8): who asked, memory and the tool index. */
export const contextRequest = {
  ...sampleRequest,
  input: {
    ...sampleRequest.input,
    requester: {
      key: "u1",
      is_admin: true,
      can_restrict_members: true,
      can_delete_messages: false,
      is_owner: false,
      is_anonymous_admin: false,
      x_future: 1,
    },
    short_term_memory: "The meetup moved to Friday.",
    tools: [
      { name: "lookup_notes", summary: "Search the chat's documents", mode: "direct" },
      { name: "restrict_member", summary: "Mute a participant", mode: "handoff", x_future: 1 },
    ],
    x_future: 1,
  },
} as const;
