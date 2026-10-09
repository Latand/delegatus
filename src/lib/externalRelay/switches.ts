import fs from "node:fs";
import { statePath } from "@/lib/configDir";
import { withFileLock, writeRelayFile } from "./store";
export type RelaySwitch = "chat_conversations" | "compact";
const file = () => statePath("external-relay/switches.json");
function stored(): Record<string, unknown> {
  try { const value = JSON.parse(fs.readFileSync(file(), "utf8")); return value?.v === 1 ? value : {}; }
  catch { return {}; }
}
export function readRelaySwitches() {
  const value = stored();
  const chat_conversations = value.chat_conversations === true;
  return { chat_conversations, compact: chat_conversations && value.compact === true };
}
export function setRelaySwitch(name: RelaySwitch, on: boolean) {
  withFileLock(file(), () => writeRelayFile(file(), { ...stored(), v: 1, [name]: on }));
  return readRelaySwitches();
}
