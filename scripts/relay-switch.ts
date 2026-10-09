import "@/lib/state/owner/tool";
import { readRelaySwitches, setRelaySwitch, type RelaySwitch } from "@/lib/externalRelay/switches";
const [name, value] = process.argv.slice(2);
if (name === "status") console.log(JSON.stringify(readRelaySwitches()));
else if (["chat_conversations", "compact"].includes(name) && ["on", "off"].includes(value))
  console.log(JSON.stringify(setRelaySwitch(name as RelaySwitch, value === "on")));
else { console.error("Usage: relay-switch.ts status | <chat_conversations|compact> on|off"); process.exitCode = 2; }
