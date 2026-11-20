import { expect, test } from "bun:test";
import { NextRequest } from "next/server";
import { soloBrowserSession } from "@/lib/agent/operatorSession";
import { readRelayStore, updateRelayStore, newTargetSettings, type PairedRelay } from "@/lib/externalRelay/store";
import { PATCH } from "./route";

for (const engine of ["codex", "codex-cloud"] as const) {
  for (const model of ["gpt-6.2-sol", "gpt-6.2-astra", "gpt-6.2-unknown"]) {
    test(`${engine} target model admission: ${model}`, async () => {
      const target = newTargetSettings({ target_id: "target", name: "Target", answered_by: "install", fallback: "service" });
      const relay: PairedRelay = {
        id: "model-relay", origin: "https://relay.example", api_base: "https://relay.example/v1", name: "Relay", description: "Relay",
        credential: "fixture", owner: { namespace: "fixture", id: "owner", display_name: "Owner", handle: null },
        pairedAt: "2026-11-17T00:00:00.000Z", paused: true,
        features: [], limits: { max_response_bytes: 1048576, max_wait_s: 25, max_answer_chars: 4000 }, targets: [target],
      };
      updateRelayStore(store => ({ ...store, relays: [relay] }));
      const origin = "http://127.0.0.1:8899";
      const response = await PATCH(new NextRequest(`${origin}/api/external-relay/relays/${relay.id}`, {
        method: "PATCH", headers: { cookie: `llv_operator=${soloBrowserSession()}`, origin, host: "127.0.0.1:8899", "content-type": "application/json" },
        body: JSON.stringify({ target: { id: target.id, engine, model, effort: "max" } }),
      }), { params: Promise.resolve({ id: relay.id }) });
      const admitted = model !== "gpt-6.2-unknown";
      expect(response.status).toBe(admitted ? 200 : 400);
      expect(readRelayStore().relays[0]!.targets[0]).toMatchObject(admitted ? { engine, model, effort: "max" } : target);
    });
  }
}
