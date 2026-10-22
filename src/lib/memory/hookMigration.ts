import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { stateDir } from "@/lib/configDir";
import { assertStateStartupMutation } from "@/lib/stateOwnership";
import { codexMemoryHookConfig } from "./hook";

interface Span { start: number; end: number; properties?: Map<string, Span>; items?: Span[] }

/** Parse spans only after JSON.parse has validated the complete document. */
function jsonSpans(source: string): Span {
  JSON.parse(source);
  const tokens = [...source.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\],:]|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g)];
  let cursor = 0;
  function value(): Span {
    const token = tokens[cursor++];
    const result: Span = { start: token.index!, end: token.index! + token[0].length };
    if (token[0] === "{") {
      result.properties = new Map();
      while (tokens[cursor][0] !== "}") {
        const key = JSON.parse(tokens[cursor++][0]); cursor++; // colon
        result.properties.set(key, value());
        if (tokens[cursor][0] === ",") cursor++;
      }
    } else if (token[0] === "[") {
      result.items = [];
      while (tokens[cursor][0] !== "]") {
        result.items.push(value());
        if (tokens[cursor][0] === ",") cursor++;
      }
    } else return result;
    const last = tokens[cursor++]; result.end = last.index! + 1;
    return result;
  }
  return value();
}

type Edit = { start: number; end: number; text?: string };
const generatedName = /^shared-memory-(?:trust-)?[a-f0-9]{12}\.mjs(?:\.[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\.tmp)?$/;
const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

function legacyCommand(command: unknown, directory: string): boolean {
  if (typeof command !== "string") return false;
  // Match only the command this installer shipped, including its exact home.
  const prefix = `bun ${quote(directory + path.sep)}`.slice(0, -1);
  if (!command.startsWith(prefix) || !command.endsWith("' 2>/dev/null || true")) return false;
  const name = command.slice(prefix.length, -"' 2>/dev/null || true".length);
  return /^shared-memory-[a-f0-9]{12}\.mjs$/.test(name);
}

function archivedCodexHome(home: string): { root: string; formerHome: string; sharedConfig: string } | null {
  const resolved = path.resolve(home);
  const parts = resolved.split(path.sep);
  const length = parts.length;
  if (parts[length - 4] !== "shared" || parts[length - 3] !== "codex" || parts[length - 2] !== "retired"
    || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(parts[length - 1] ?? "")) return null;
  const root = parts.slice(0, -4).join(path.sep) || path.parse(resolved).root;
  const accountId = parts[length - 1];
  const codexHome = path.resolve(process.env.LLV_CODEX_HOME || path.join(os.homedir(), ".codex"));
  return {
    root,
    formerHome: path.join(root, "accounts", "codex", accountId),
    sharedConfig: path.join(codexHome, "config.toml"),
  };
}

function removeArrayItems(items: Span[], selected: Set<number>): Edit[] {
  const edits: Edit[] = [];
  for (let i = 0; i < items.length; i++) {
    if (!selected.has(i)) continue;
    const first = i;
    while (selected.has(i + 1)) i++;
    edits.push(i + 1 < items.length ? { start: items[first].start, end: items[i + 1].start }
      : { start: first > 0 ? items[first - 1].end : items[first].start, end: items[i].end });
  }
  return edits;
}

function edit(source: string, edits: Edit[]): string {
  for (const range of edits.sort((a, b) => b.start - a.start)) source = source.slice(0, range.start) + (range.text ?? "") + source.slice(range.end);
  return source;
}

/** Find complete top-level statements in validated TOML. Comments, multiline
 * strings and nested values can contain convincing table/assignment text. */
function tomlStatements(source: string) {
  const headers: Array<{ start: number; end: number; table: Record<string, unknown> }> = [];
  const assignments: Array<{ start: number; end: number; key: string }> = [];
  let multiline: string | null = null, depth = 0;
  let pending: typeof assignments[number] | undefined;
  for (const match of source.matchAll(/[^\n]*(?:\n|$)/g)) {
    const line = match[0]; if (!line) continue;
    const start = match.index!, end = start + line.length;
    if (!multiline && depth === 0) {
      if (/^[ \t]*\[/.test(line)) {
        try { headers.push({ start, end, table: Bun.TOML.parse(line) as Record<string, unknown> }); continue; }
        catch { /* A nested value is not a table header. */ }
      }
      const assignment = /^[ \t]*(trusted_hash|enabled)[ \t]*=/.exec(line);
      if (assignment) { pending = { start, end, key: assignment[1] }; assignments.push(pending); }
    }
    let quoted: string | null = null;
    for (let i = 0; i < line.length; i++) {
      if (multiline) {
        if (multiline === '"""' && line[i] === "\\") i++;
        else if (line.startsWith(multiline, i)) { i += 2; multiline = null; }
      } else if (quoted) {
        if (quoted === '"' && line[i] === "\\") i++;
        else if (line[i] === quoted) quoted = null;
      } else if (line[i] === "#") break;
      else if (line.startsWith('"""', i) || line.startsWith("'''", i)) { multiline = line.slice(i, i + 3); i += 2; }
      else if (line[i] === '"' || line[i] === "'") quoted = line[i];
      else if (line[i] === "[" || line[i] === "{") depth++;
      else if (line[i] === "]" || line[i] === "}") depth--;
    }
    if (pending) { pending.end = end; if (!multiline && depth === 0) pending = undefined; }
  }
  return { headers, assignments };
}

async function read(file: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("memory hook migration refuses a linked file");
    return await fs.readFile(file, "utf8");
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
}

async function replace(file: string, before: string, after: string, backup: string): Promise<void> {
  if (before === after) return;
  const digest = crypto.createHash("sha256").update(before).digest("hex");
  await fs.writeFile(path.join(backup, `${path.basename(file)}-${digest}`), before, { mode: 0o600, flag: "wx" }).catch(error => {
    if (error.code !== "EEXIST") throw error;
  });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const stat = await fs.stat(file);
    await fs.writeFile(temporary, after, { mode: stat.mode & 0o777 });
    if (await read(file) !== before) throw new Error("memory hook migration observed a concurrent config edit; retry required");
    await fs.rename(temporary, file);
  } finally { await fs.rm(temporary, { force: true }); }
}

/** Idempotent upgrade. Empty groups retain personal hook group/trust indices.
 * Trust retires before declarations, so a restart always retains its proof.
 * Backups live in state, outside the Codex home. */
export async function retireLegacyCodexMemoryHooks(home: string, backupRoot: string): Promise<void> {
  const hookFile = path.join(home, "hooks.json"), configLink = path.join(home, "config.toml");
  const archived = archivedCodexHome(home);
  const directory = path.join(home, ".llv", "hooks");
  const hookTarget = await fs.realpath(hookFile).catch(error => { if (error.code === "ENOENT") return null; throw error; });
  const original = hookTarget === null ? null : await read(hookTarget);
  const canonicalHome = await fs.realpath(home).catch(error => { if (error.code === "ENOENT") return home; throw error; });
  const formerHome = archived?.formerHome;
  const canonicalFormerHome = formerHome ? await fs.realpath(formerHome).catch(async error => {
    if (error.code !== "ENOENT") throw error;
    if (!archived) return formerHome;
    const canonicalRoot = await fs.realpath(archived.root);
    return path.join(canonicalRoot, "accounts", "codex", path.basename(formerHome));
  }) : null;
  const hookSources = [...new Set([hookFile, path.join(canonicalHome, "hooks.json"), hookTarget,
    ...(formerHome ? [path.join(formerHome, "hooks.json")] : []),
    ...(canonicalFormerHome ? [path.join(canonicalFormerHome, "hooks.json")] : [])].filter((file): file is string => file !== null))];
  const files = await fs.readdir(directory).catch(error => { if (error.code === "ENOENT") return []; throw error; });
  const directories = [...new Set([directory, await fs.realpath(directory).catch(error => { if (error.code === "ENOENT") return directory; throw error; }),
    ...(formerHome ? [path.join(formerHome, ".llv", "hooks")] : []),
    ...(canonicalFormerHome ? [path.join(canonicalFormerHome, ".llv", "hooks")] : [])])];
  const generated = new Map<string, string>();
  for (const name of files.filter(name => generatedName.test(name))) {
    const bytes = await read(path.join(directory, name));
    if (bytes !== null) generated.set(name, bytes);
  }
  if (!original?.includes("shared-memory-") && !generated.size) return;
  // Managed accounts intentionally share config.toml through an overlay link.
  // Replace its regular target and retain the link itself.
  const configFile = await fs.realpath(configLink).catch(error => {
    if (error.code === "ENOENT") return archived ? archived.sharedConfig : configLink;
    throw error;
  });
  const config = await read(configFile);
  // Validate before any mutation or retirement, including generated programs.
  const tree = original === null ? null : jsonSpans(original);
  const states: Record<string, { enabled?: boolean; trusted_hash?: string }> = config === null ? {} : (Bun.TOML.parse(config) as { hooks?: { state?: Record<string, { enabled?: boolean; trusted_hash?: string }> } }).hooks?.state ?? {};
  const backup = path.join(backupRoot, crypto.createHash("sha256").update(home).digest("hex").slice(0, 16));
  const edits: Edit[] = [];
  const ownedKeys = new Set<string>();
  const orphanHashes = new Set<string>();
  for (const name of generated.keys()) {
    const originalName = /^(shared-memory-[a-f0-9]{12}\.mjs)(?:\.|$)/.exec(name)?.[1];
    if (!originalName) continue;
    for (const directory of directories) {
      const command = `bun ${quote(path.join(directory, originalName))} 2>/dev/null || true`;
      orphanHashes.add(Object.values(codexMemoryHookConfig({ type: "command", command, timeout: 2, additionalContextLimit: 40000 }).state)[0].trusted_hash);
    }
  }
  for (const [key, state] of Object.entries(states)) {
    if (hookSources.some(source => key.startsWith(`${source}:user_prompt_submit:`)) && state.trusted_hash && orphanHashes.has(state.trusted_hash)) ownedKeys.add(key);
  }
  const groupArray = tree?.properties?.get("hooks")?.properties?.get("UserPromptSubmit");
  const groups = groupArray?.items ?? [];
  const appendedGroups: string[] = [], aliases: string[] = [];
  for (const [groupIndex, group] of groups.entries()) {
    const handlers = group.properties?.get("hooks")?.items ?? [];
    const selected = new Set<number>();
    for (const [index, handler] of handlers.entries()) {
      const entry = JSON.parse(original!.slice(handler.start, handler.end));
      if (!entry || entry.type !== "command" || !directories.some(directory => legacyCommand(entry.command, directory))) continue;
      selected.add(index);
      for (const source of hookSources) ownedKeys.add(`${source}:user_prompt_submit:${groupIndex}:${index}`);
    }
    const retained = handlers.map((span, index) => ({ span, index })).filter(entry => !selected.has(entry.index));
    const sourceKey = (source: string, index: number) => `${source}:user_prompt_submit:${groupIndex}:${index}`;
    if (selected.size && retained.some((entry, index) => index !== entry.index && hookSources.some(source => states[sourceKey(source, entry.index)]))) {
      // A user may have put personal handlers beside ours. Move the surviving
      // group to a free index and copy its trust there, retaining every byte of
      // the original personal declarations and state tables. Native trust hashes
      // depend on the declaration/matcher, not on the group/handler indices.
      let target = groups.length + appendedGroups.length;
      const key = (source: string, index: number) => `${source}:user_prompt_submit:${target}:${index}`;
      while (retained.some((entry, index) => hookSources.some(source => states[key(source, index)] && (states[key(source, index)].enabled !== states[sourceKey(source, entry.index)]?.enabled || states[key(source, index)].trusted_hash !== states[sourceKey(source, entry.index)]?.trusted_hash)))) {
        appendedGroups.push('{"hooks":[]}'); target++;
      }
      const raw = original!.slice(group.start, group.end);
      appendedGroups.push(edit(raw, removeArrayItems(handlers, selected).map(range => ({ start: range.start - group.start, end: range.end - group.start }))));
      for (const [index, entry] of retained.entries()) for (const source of hookSources) {
        const state = states[sourceKey(source, entry.index)];
        if (!state || states[key(source, index)]) continue;
        aliases.push(`[hooks.state.${JSON.stringify(key(source, index))}]\n${state.enabled === undefined ? "" : `enabled = ${state.enabled}\n`}${state.trusted_hash === undefined ? "" : `trusted_hash = ${JSON.stringify(state.trusted_hash)}\n`}`);
      }
      edits.push(...removeArrayItems(handlers, new Set(handlers.map((_, index) => index))));
    } else edits.push(...removeArrayItems(handlers, selected));
  }
  if (appendedGroups.length) edits.push({ start: groups.at(-1)!.end, end: groups.at(-1)!.end, text: "," + appendedGroups.join(",") });
  if (!edits.length && !ownedKeys.size && !generated.size) return;
  await fs.mkdir(backup, { recursive: true, mode: 0o700 });
  if (config !== null && ownedKeys.size) {
    // Codex's config/value/write emits a dedicated quoted table for each key.
    // Slice only that table; every other byte, including comments, survives.
    const { headers, assignments } = tomlStatements(config);
    const removals: Edit[] = [];
    for (const [index, header] of headers.entries()) {
      const table = header.table;
      const keys = Object.keys((table.hooks as { state?: object } | undefined)?.state ?? {});
      if (keys.length === 1 && ownedKeys.has(keys[0])) {
        // Comments and whitespace may have been added by the owner after setup.
        // Remove generated assignments individually so those bytes survive.
        if (Object.keys(states[keys[0]] ?? {}).every(key => key === "enabled" || key === "trusted_hash")) removals.push({ start: header.start, end: header.end });
        for (const statement of assignments) if (statement.start >= header.end && statement.start < (headers[index + 1]?.start ?? config.length)) removals.push(statement);
      }
    }
    let next = edit(config, removals);
    if (aliases.length) next += (next.endsWith("\n") ? "\n" : "\n\n") + aliases.join("\n");
    Bun.TOML.parse(next);
    const currentConfigFile = await fs.realpath(configLink).catch(error => {
      if (error.code === "ENOENT") return archived ? archived.sharedConfig : configLink;
      throw error;
    });
    if (currentConfigFile !== configFile) throw new Error("memory hook migration observed a changed config link; retry required");
    await replace(configFile, config, next, backup);
  }
  if (original !== null && hookTarget !== null) {
    const next = edit(original, edits); JSON.parse(next);
    if (await fs.realpath(hookFile) !== hookTarget) throw new Error("memory hook migration observed a changed hooks link; retry required");
    await replace(hookTarget, original, next, backup);
  }
  for (const [name, bytes] of generated) {
    const file = path.join(directory, name);
    // Retain the removed program only in the protected migration backup.
    await fs.writeFile(path.join(backup, name), bytes, { mode: 0o600 });
    if (await read(file) !== bytes) throw new Error("memory hook migration observed a concurrent hook edit; retry required");
    await fs.unlink(file);
  }
}

/** Runs once per serving startup, before any host adoption or new launch. */
export async function retireLegacyCodexMemoryHooksAtStartup(): Promise<void> {
  const state = stateDir();
  assertStateStartupMutation(state, "retire global Codex memory hooks");
  const homes = new Set([path.join(os.homedir(), ".codex"), process.env.LLV_CODEX_HOME, process.env.CODEX_HOME].filter((home): home is string => Boolean(home)));
  for (const accounts of [path.join(path.dirname(state), "accounts", "codex"), path.join(path.dirname(state), "shared", "codex", "retired")]) {
    for (const entry of await fs.readdir(accounts, { withFileTypes: true }).catch(error => { if (error.code === "ENOENT") return []; throw error; })) {
      if (entry.isDirectory()) homes.add(path.join(accounts, entry.name));
    }
  }
  for (const home of homes) await retireLegacyCodexMemoryHooks(home, path.join(state, "migrations", "codex-memory-hooks"));
}
