import { relayCall } from "./client";
// Real transport exercises the journal's process-local rate limit.
for (let i = 0; i < 65; i++) {
  try { await relayCall(process.argv[2]!, "/requests/private-request/complete", "POST", {}); } catch { /* expected local refusal */ }
}
