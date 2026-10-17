import { attemptPrototypeDelivery, type PrototypeDeliveryPorts } from "./decision";
import { loadSeatRounds } from "./seatRounds";
import { prototypeWorld } from "./world";

let attempts = 0;
const ports: PrototypeDeliveryPorts = { now: () => Date.parse("2026-10-16T08:00:00Z"),
  world: { ...prototypeWorld, orchestrator: () => "conversation_old" },
  delivery: { recover: async () => null, send: async () => { attempts++; return { state: "failed" }; }, retry: async () => { throw new Error("unexpected retry"); } } };
for (let i = 0; i < 12; i++) for (const round of loadSeatRounds()) await attemptPrototypeDelivery(null, round.id, ports);
console.log(JSON.stringify({ attempts }));
