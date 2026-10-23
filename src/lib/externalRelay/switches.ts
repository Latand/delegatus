import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { withFileTransactionSync } from "@/lib/state/fileTransaction";
import { writeRelayFile } from "./store";
export type RelaySwitch = "relay:rich_media" | "chain_conversations" | "compact" | "relay:owner_tools:enabled";
const file = () => statePath("external-relay/switches.json");
function stored(): Record<string, unknown> {
  try { const value = JSON.parse(fs.readFileSync(file(), "utf8")); return value?.v === 1 ? value : {}; }
  catch { return {}; }
}
export function readRelaySwitches() {
  const value = stored();
  const chain_conversations = value.chain_conversations !== false;
  return { rich_media: value["relay:rich_media"] !== false, chain_conversations, compact: chain_conversations && value.compact === true,
    owner_tools: value["relay:owner_tools:enabled"] === true };
}
/* The file's transaction lock, which an install transfer holds while it
   writes the same file, so neither loses the other's switch. */
export function setRelaySwitch(name: RelaySwitch, on: boolean) {
  withFileTransactionSync(file(), "relay switches are busy", () => writeRelayFile(file(), { ...stored(), v: 1, [name]: on }));
  return readRelaySwitches();
}
