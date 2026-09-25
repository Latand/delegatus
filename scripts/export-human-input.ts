/**
 * Export one host's human input for the activity dashboard
 * (docs/design/activity-dashboard.md, "Cross-host human input").
 *
 *   bun scripts/export-human-input.ts --host stage --from 2026-09-19 --to 2026-09-23 --out <file>
 *
 * Run it on the host whose transcripts it reads. It walks every transcript
 * store there — the local Claude and Codex homes, every account store, the
 * shared mirror and retired archives, plus any `--root` — classifies each user
 * record, keeps only real operator input, deduplicates copies, and writes one
 * file: a manifest naming the host, the span it speaks for and the count of
 * every record excluded by reason, then one line per input with opaque ids, a
 * content hash, a time, a project, a kind and a surface. No text, path or
 * session id is written.
 *
 * `--only-roots` reads the `--root` directories alone; `--no-registry` skips
 * the registry, so only marked or typed input counts, and the first message of
 * every Delegatus session is excluded as unregistered.
 *
 * Copy the file into `<state>/activity/hosts/<host>/` on the host that runs
 * the dashboard. Dates are whole days in the configured zone (Europe/Kyiv
 * unless `--tz`); `--to` defaults to now. Reads only: the registry and the
 * delivery ledgers are consulted for who launched a conversation and who sent
 * a delivered message, and nothing in the state directory is written.
 */
/* FIRST, and before every other import: the claim has to precede the modules
   below, which resolve the operator's state directory while they load (#1905).
   See `src/lib/state/owner/tool.ts`. */
import "../src/lib/state/owner/tool";

import fs from "node:fs";
import path from "node:path";

import { conversationResolver } from "../src/lib/activity/conversationResolver";
import { exportLines, validHostId } from "../src/lib/activity/humanInput";
import { METHOD_DEFAULTS, validTimeZone, zonedDate } from "../src/lib/activity/method";
import { exportHumanInputs, listTranscriptFiles } from "../src/lib/activity/transcriptExport";
import { claudeProjectRoots, sharedClaudeProjectsRoot } from "../src/lib/accounts/claude";
import { codexSessionRoots } from "../src/lib/accounts/codex";
import { agentRegistry, type RegistryFile } from "../src/lib/agent/registry";
import { ROOTS } from "../src/lib/scanner/roots";

function fail(message: string): never {
  console.error(`export-human-input: ${message}`);
  process.exit(2);
}

function argument(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function argumentList(name: string): string[] {
  return process.argv.flatMap((value, index) => (value === `--${name}` && process.argv[index + 1] ? [process.argv[index + 1]!] : []));
}

const host = argument("host");
if (!validHostId(host)) fail("--host is required: lowercase letters, digits, dot, dash or underscore");
const tz = validTimeZone(argument("tz") ?? METHOD_DEFAULTS.tz) ?? fail("--tz is not a known zone");
const fromDay = zonedDate(argument("from") ?? "", tz) ?? fail("--from is required as YYYY-MM-DD");
const now = Date.now();
const toArgument = argument("to");
const toDay = toArgument ? zonedDate(toArgument, tz) ?? fail("--to must be YYYY-MM-DD") : null;
const out = argument("out") ?? fail("--out is required: the export file to write");
const useRegistry = !process.argv.includes("--no-registry");

function storeRoots(): string[] {
  if (process.argv.includes("--only-roots")) return [...new Set(argumentList("root").map((root) => path.resolve(root)))].filter((root) => fs.existsSync(root));
  const roots = [ROOTS["claude-projects"], ROOTS["codex-sessions"], ...argumentList("root")];
  try {
    roots.push(...claudeProjectRoots(), sharedClaudeProjectsRoot(), ...codexSessionRoots());
  } catch {
    /* No Delegatus account layout on this host: the plain homes and --root. */
  }
  return [...new Set(roots.map((root) => path.resolve(root)))].filter((root) => fs.existsSync(root));
}

let snapshot: RegistryFile | null = null;
if (useRegistry) {
  try {
    snapshot = agentRegistry().readOnlySnapshot();
  } catch {
    console.error("export-human-input: the registry is not readable here; delivered messages count only when marked");
  }
}
const resolve = conversationResolver(snapshot);

const from = fromDay.start;
const to = toDay ? toDay.end : now;
const files = listTranscriptFiles(storeRoots(), from);
const result = await exportHumanInputs({ host, from, to, now, files, resolve });
fs.mkdirSync(path.dirname(path.resolve(out)), { recursive: true });
fs.writeFileSync(out, exportLines(result.manifest, result.inputs), { mode: 0o600 });
const excluded = Object.entries(result.manifest.excluded).map(([reason, count]) => `${reason} ${count}`).join(", ") || "none";
console.log(`export-human-input: ${result.inputs.length} inputs from ${result.manifest.records} user records in ${files.length} transcripts; excluded: ${excluded}`);
