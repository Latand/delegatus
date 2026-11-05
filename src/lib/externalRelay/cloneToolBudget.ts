import fs from "node:fs";
import { externalRelayFile } from "./store";

/** Two maximum-size upload attempts plus directory reads fit inside eight
 * minutes. This changes waiting only; the send still needs live limits and
 * rights at dispatch. Earlier caller deadlines remain authoritative. */
export function cloneFileCallBudgetMs(): number | null {
  try {
    const file = externalRelayFile("relays");
    if (fs.statSync(file).size > 16 * 1024 * 1024) return null;
    const store = JSON.parse(fs.readFileSync(file, "utf8")) as { v?: unknown; relays?: unknown };
    return store.v === 1 && Array.isArray(store.relays) && store.relays.slice(0, 100).some(relay => relay?.paused === false
      && Array.isArray(relay.features) && relay.features.includes("clone_send_methods"))
      ? 8 * 60_000 : null;
  } catch { return null; }
}
