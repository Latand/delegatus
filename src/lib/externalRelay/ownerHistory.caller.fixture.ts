import fs from "node:fs";
import path from "node:path";
import { procBackend } from "@/lib/proc";
import { destinationRelay, destinationTarget } from "./ownerDestination.fixture";
import { externalRelayFile } from "./store";

/** Real authorization reads a live owner-run ledger and process identity. */
export function historyOwnerRun(conversationId: string) {
  const relay = destinationRelay([destinationTarget("first", true)]);
  fs.mkdirSync(path.dirname(externalRelayFile("runs")), { recursive: true });
  fs.writeFileSync(externalRelayFile("relays"), JSON.stringify({ v: 1, relays: [relay], pending: [] }));
  fs.writeFileSync(externalRelayFile("runs"), JSON.stringify({ v: 1, runs: [{ relayId: relay.id, targetId: "first", conversationId,
    ownerPid: process.pid, ownerIdentity: procBackend.processIdentity(process.pid), ownerTurn: {} }] }));
  return () => fs.writeFileSync(externalRelayFile("runs"), JSON.stringify({ v: 1, runs: [] }));
}
