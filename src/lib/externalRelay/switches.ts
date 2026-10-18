import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { withFileLock, writeRelayFile } from "./store";
export type RelaySwitch = "chain_conversations" | "compact" | "relay:owner_tools:enabled";
const file = () => statePath("external-relay/switches.json");
function stored(): Record<string, unknown> {
  try { const value = JSON.parse(fs.readFileSync(file(), "utf8")); return value?.v === 1 ? value : {}; }
  catch { return {}; }
}
export function readRelaySwitches() {
  const value = stored();
  const chain_conversations = value.chain_conversations !== false;
  return { chain_conversations, compact: chain_conversations && value.compact === true,
    owner_tools: value["relay:owner_tools:enabled"] === true };
}
export function setRelaySwitch(name: RelaySwitch, on: boolean) {
  withFileLock(file(), () => writeRelayFile(file(), { ...stored(), v: 1, [name]: on }));
  return readRelaySwitches();
}
