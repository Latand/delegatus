import { afterAll, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ownerRelayAuthorized, ownerRelayAuthorizedAsync } from "./ownerAuthority";
import { InlineRelayLeaseTransport, RelayLeaseTransport } from "./relayLeaseTransport";
import { dropRun, reserveRun, updateRelayStore, type PairedRelay } from "./store";
import { startTestRelay } from "./testRelay";
import type { ExternalRelayCompletion } from "./protocol";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "relay-timeout-status-"));
process.env.LLV_STATE_DIR = path.join(root, "state");
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

for (const kind of ["inline", "worker"] as const)
  for (const scenario of ["status", "rich_status", "quarantine_failure", "quarantine_raw", "quarantine_no_diagnostic", "quarantine_paused", "quarantine_foreign", "raw_output", "attachment", "button", "rich_format", "extra_payload", "normal_reply", "paused", "disabled", "owner_disabled", "missing", "foreign", "revoked_retry"] as const)
    test(`${kind} deadline status authority: ${scenario}`, async () => {
      const posts: unknown[] = [];
      const service = await startTestRelay((req, body) => {
        if (req.url?.endsWith("/complete")) {
          posts.push(body);
          if (scenario === "revoked_retry" && posts.length === 1) {
            updateRelayStore(store => ({ ...store, relays: [{ ...paired, paused: true }] }));
            return { status: 503, body: { error: { code: "unavailable" } } };
          }
        }
        return { body: { status: "ok" } };
      });
      const paired: PairedRelay = {
        id: "status_fixture", origin: service.origin, api_base: `${service.origin}/v1`, name: "Fixture", description: "",
        credential: "x".repeat(43), owner: { namespace: "test", id: "owner", display_name: "Owner", handle: null },
        pairedAt: "2026-10-22T12:00:00Z", paused: false,
        limits: { max_response_bytes: 1_048_576, max_wait_s: 25, max_answer_chars: 4000 },
        targets: [{ id: "target_1", name: "Target", answered_by: "install", fallback: "none", enabled: true,
          engine: "codex", model: "gpt-6-sol", effort: "low", project: null, concurrency: 1, hardCapMinutes: 1, ownerTier: true }],
      };
      const requestId = `status_${kind}_${scenario}`;
      updateRelayStore(store => ({ ...store, relays: [paired] }));
      reserveRun({ requestId, relayId: paired.id, targetId: "target_1", leaseId: "status_lease", ownerPid: process.pid,
        ownerIdentity: null, childPid: null, childIdentity: null, runDir: root, startedAt: "2026-10-22T12:00:00Z",
        ownerTurn: { clientAttemptId: `relay-owner-${requestId}`, cancel: "interrupt", confirmed: false,
          ...(scenario.startsWith("quarantine_") ? { quarantinedAt: "2026-10-22T12:10:00Z",
            ...(scenario !== "quarantine_no_diagnostic" ? { diagnostic: { source: "launch" as const, message: "Launch failed" } } : {}) } : {}) } }, 1);
      const transport = kind === "inline"
        ? new InlineRelayLeaseTransport(paired, requestId, "target_1", "status_lease", 10_000, () => {}, null)
        : new RelayLeaseTransport(paired, requestId, "target_1", "status_lease", 10_000, () => {});
      try {
        await transport.ready;
        // Change authority after the transport has started: every delivery
        // must read current settings, including in the separately owned helper.
        if ((scenario === "paused" || scenario === "quarantine_paused")) updateRelayStore(store => ({ ...store, relays: [{ ...paired, paused: true }] }));
        if (scenario === "disabled") updateRelayStore(store => ({ ...store, relays: [{ ...paired, targets: [{ ...paired.targets[0]!, enabled: false }] }] }));
        if (scenario === "owner_disabled") updateRelayStore(store => ({ ...store, relays: [{ ...paired, targets: [{ ...paired.targets[0]!, ownerTier: false }] }] }));
        if (scenario === "missing") dropRun(requestId);
        if ((scenario === "foreign" || scenario === "quarantine_foreign")) updateRelayStore(store => ({ ...store, relays: [{ ...paired, id: "foreign_relay" }] }));
        expect(ownerRelayAuthorized(paired.id, "target_1", requestId)).toBe(false);
        expect(await ownerRelayAuthorizedAsync(paired.id, "target_1", requestId)).toBe(false);
        const body: ExternalRelayCompletion = { lease_id: "status_lease", outcome: "answered", duration_ms: 600_000,
          answer: { action: "reply", text: scenario === "raw_output" ? "Late agent output" : "Ran out of time.", reply_to: "m1",
            ...(scenario === "rich_status" ? { format: "plain" as const, buttons: [], attachments: [] } : {}),
            ...(scenario === "rich_format" ? { format: "rich_markdown" as const } : {}),
            ...(scenario === "button" ? { buttons: [[{ text: "Late action", url: "https://example.org/action" }]] } : {}),
            ...(scenario === "attachment" ? { attachments: [{ attachment_id: "pending_file", kind: "document" as const, caption: "Late file" }] } : {}) } };
        if (scenario === "extra_payload") Object.assign(body, { unexpected: "Late payload" });
        const result = await transport.complete(body, Date.now() + (scenario === "revoked_retry" ? 5000 : 0), 20, scenario.startsWith("quarantine_") && scenario !== "quarantine_raw" ? "failure" : scenario === "normal_reply" || scenario === "quarantine_raw" ? true : "status");
        expect(result).toMatchObject(scenario === "status" || scenario === "rich_status" || scenario === "quarantine_failure" ? { delivery: "accepted", body }
          : { body: { outcome: "failed", reason: "cancelled" } });
        expect(posts).toHaveLength(scenario === "revoked_retry" ? 2 : 1);
        expect(posts.at(-1)).toMatchObject(scenario === "status" || scenario === "rich_status" || scenario === "quarantine_failure" ? { outcome: "answered" }
          : { outcome: "failed", reason: "cancelled" });
        // A status exception must never restore the stopped turn's execution.
        expect(ownerRelayAuthorized(paired.id, "target_1", requestId)).toBe(false);
        expect(await ownerRelayAuthorizedAsync(paired.id, "target_1", requestId)).toBe(false);
      } finally {
        await transport.close();
        dropRun(requestId);
        updateRelayStore(store => ({ ...store, relays: [] }));
        await service.close();
      }
    });
