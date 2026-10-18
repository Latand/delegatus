import "@/lib/state/owner/tool";
import { readRelaySwitches, setRelaySwitch, type RelaySwitch } from "@/lib/externalRelay/switches";
const [name, value] = process.argv.slice(2);
if (name === "status") console.log(JSON.stringify(readRelaySwitches()));
else if (["chain_conversations", "compact", "owner_tools"].includes(name) && ["on", "off"].includes(value))
  console.log(JSON.stringify(setRelaySwitch((name === "owner_tools" ? "relay:owner_tools:enabled" : name) as RelaySwitch, value === "on")));
else { console.error("Usage: relay-switch.ts status | <chain_conversations|compact|owner_tools> on|off"); process.exitCode = 2; }
