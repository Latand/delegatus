import { stageAttemptGuardScript } from "./stageAttemptGuard";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const hooks = ["applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit", "pre-merge-commit",
  "prepare-commit-msg", "commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge",
  "pre-push", "pre-receive", "update", "proc-receive", "post-receive", "post-update",
  "reference-transaction", "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate",
  "fsmonitor-watchman", "p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit",
  "post-index-change"];
const roots = new Map<string, string>();
/** An environment as a launch reads it: any variables, none of them required. */
export type AgentEnvironment = Readonly<Record<string, string | undefined>>;
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";

/** Read at most one generated body. Foreign files can be arbitrarily large;
 * links and nonregular files never qualify as a cached executable. */
function verifiedHook(target: string, body: Buffer, digest: string): boolean {
  let fd: number | undefined;
  try {
    const entry = fs.lstatSync(target);
    if (!entry.isFile() || entry.size !== body.length
      || (process.platform !== "win32" && (entry.mode & 0o777) !== 0o700)) return false;
    fd = fs.openSync(target, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.size !== body.length || opened.ino !== entry.ino || opened.dev !== entry.dev) return false;
    const bytes = Buffer.alloc(body.length + 1);
    let read = 0;
    while (read < bytes.length) {
      const count = fs.readSync(fd, bytes, read, bytes.length - read, null);
      if (!count) break;
      read += count;
    }
    return read === body.length && crypto.createHash("sha256").update(bytes.subarray(0, read)).digest("hex") === digest;
  } catch (error) {
    if (["ENOENT", "ELOOP"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    throw error;
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Git's transaction hook can refuse an amend even with --no-verify or
 * --reset-author. Scope it to the child environment; preserve repository hooks
 * and config, and refuse branch-history replacements that discard another author.
 * This is a cooperative agent guard, not a sandbox against hostile shell code.
 */
export function agentHistoryGuardEnv(source: AgentEnvironment, name: string, email: string, coauthor?: string): Record<string, string | undefined> {
  let count = Number(source.GIT_CONFIG_COUNT ?? 0);
  if (!Number.isSafeInteger(count) || count < 0 || count > 1024) throw new Error("Invalid agent Git environment");
  if (count > 0 && source.GIT_CONFIG_KEY_0 === undefined) throw new Error("Invalid agent Git environment");
  if (count > 0 && source[`GIT_CONFIG_KEY_${count - 1}`] === "core.hooksPath"
    && source[`GIT_CONFIG_VALUE_${count - 1}`] === source.LLV_AGENT_GIT_GUARD_DIR) count--;
  const env: Record<string, string | undefined> = {};
  for (let i = 0; i < count; i++) {
    for (const field of ["KEY", "VALUE"]) {
      const key = `GIT_CONFIG_${field}_${i}`;
      if (source[key] === undefined) throw new Error("Invalid agent Git environment");
      env[key] = source[key];
    }
  }
  const script = `#!/bin/sh
set -eu
refuse() {
  echo "Delegatus: refusing to rewrite a commit whose author is not this configured identity; add a new commit on top instead." >&2
  exit 1
}
check_author() {
  author=$(git show -s --no-show-signature --no-color --no-notes --format='%an%n%ae' "$1") || refuse
  [ "$author" = ${quote(name + "\n" + email)} ] || refuse
}
${coauthor ? `check_coauthor() {
  count=$(git show -s --no-show-signature --no-color --no-notes --format=%B "$1" | git interpret-trailers --parse | grep -Fxc -- ${quote(coauthor)} || true)
  [ "$count" = 1 ] || refuse
}` : ""}
hook=\${0##*/}
if [ "$hook" = post-rewrite ] || [ "$hook" = reference-transaction ]; then input=$(cat); fi
${stageAttemptGuardScript()}
if [ "$hook" = prepare-commit-msg ]; then
  # commit exports its effective author, including -C/-c inheritance. The
  # cherry-pick sequencer needs its own source check. --no-verify runs this hook.
  identity=$(git var GIT_AUTHOR_IDENT) || refuse
  [ "\${identity%>*}>" = ${quote(name + " <" + email + ">")} ] || refuse
  if picked=$(git rev-parse --verify -q CHERRY_PICK_HEAD); then check_author "$picked"; fi
  ${coauthor ? `git interpret-trailers --in-place --if-exists addIfDifferent --trailer ${quote(coauthor)} "$1" || exit 1` : ""}
fi
if [ "$hook" = applypatch-msg ]; then
  # git am owns this message hook; amend the mailbox message before commit
  # creation. --no-verify skips this hook, so reference-transaction below
  # independently refuses an unattributed commit.
  :
  ${coauthor ? `count=$(git interpret-trailers --parse "$1" | grep -Fxc -- ${quote(coauthor)} || true)
  [ "$count" -le 1 ] || refuse
  if [ "$count" = 0 ]; then git interpret-trailers --in-place --trailer ${quote(coauthor)} "$1" || exit 1; fi` : ""}
fi
if [ "$hook" = pre-applypatch ]; then
  # am keeps its author in the sequencer's quoted data, rather than exporting
  # it to hooks. Compare those assignments literally; never source the file.
  author_file=$(git rev-parse --git-path rebase-apply/author-script) || refuse
  author_data=$(sed -n '1,2p' "$author_file") || refuse
  [ "$author_data" = ${quote("GIT_AUTHOR_NAME=" + quote(name) + "\nGIT_AUTHOR_EMAIL=" + quote(email))} ] || refuse
fi
if [ "$hook" = reference-transaction ]; then
  if [ "\${1:-}" = prepared ]; then
    printf '%s\\n' "$input" | while read -r old new ref; do
      case "$ref" in
        refs/heads/*) ;;
        HEAD) git symbolic-ref -q HEAD >/dev/null && continue ;;
        *) continue ;;
      esac
      # A deletion or rename moves names without creating a replacement commit.
      case "$new" in *[!0]*) ;; *) continue ;; esac
      # am skips pre-applypatch with -n/--no-verify, including on continuation.
      # Validate the actual commit before publishing it. Resolve state through
      # Git so linked worktrees use their own sequencer. An abort restores an
      # older tip rather than appending a patch, and must remain available.
      applying=$(git rev-parse --git-path rebase-apply/applying) || refuse
      if [ -f "$applying" ]; then
        parents=$(git show -s --no-show-signature --no-color --no-notes --format=%P "$new") || refuse
        case "$old" in
          *[!0]*) [ "$parents" != "$old" ] || { check_author "$new"; ${coauthor ? `check_coauthor "$new";` : ""} } ;;
          *) check_author "$new"; ${coauthor ? `check_coauthor "$new";` : ""} ;;
        esac
      fi
      case "$old" in *[!0]*) ;; *) continue ;; esac
      git cat-file -e "$old^{commit}" || refuse
      removed=$(git rev-list "$new..$old") || refuse
      for commit in $removed; do
        check_author "$commit"
      done
    done || exit 1
  fi
fi
# Query the original hook configuration without this final environment entry.
# Keep the guarded environment in the forwarded hook and all of its children.
original=$(GIT_CONFIG_COUNT=${count} git config --path --get core.hooksPath) || {
  status=$?
  [ "$status" = 1 ] || exit "$status"
  common=$(git rev-parse --git-common-dir) || exit 1
  original="$common/hooks"
}
target="$original/$hook"
# A repository may have persisted the launch override, including through a
# symlink or a parent worktree's config. Keep its checked-in hooks reachable.
if [ "$target" -ef "$0" ]; then target=".githooks/$hook"; fi
# A previous launch may have persisted an older generated directory. Its
# digest differs from this launch's directory, and its hook predates the chain
# marker, so forwarding to it would recursively execute that saved hook.
if [ -n "\${LLV_AGENT_GIT_GUARD_DIR:-}" ]; then
  current_guard=$(CDPATH= cd -P "$LLV_AGENT_GIT_GUARD_DIR" 2>/dev/null && pwd -P) || current_guard=
  current_root=\${current_guard%/*/*}
  target_directory=$(CDPATH= cd -P "\${target%/*}" 2>/dev/null && pwd -P) || target_directory=
  resolved_target=$target_directory/\${target##*/}
  case "$resolved_target" in
    "$current_root"/guard-*/????????????????????????/"$hook") target=".githooks/$hook" ;;
  esac
fi
[ -x "$target" ] || { stage_owner_check "$@"; exit 0; }
[ ! "$target" -ef "$0" ] || { stage_owner_check "$@"; exit 0; }
# A repository wrapper can invoke this guard again. Apply the guard above on
# every entry, but forward to the same repository hook only once per chain.
chain_target=$(CDPATH= cd -P "\${target%/*}" && pwd -P)/$hook
[ "\${LLV_AGENT_GIT_CHAINED_HOOK:-}" != "$chain_target" ] || { stage_owner_check "$@"; exit 0; }
export LLV_AGENT_GIT_CHAINED_HOOK="$chain_target"
if [ "$hook" = reference-transaction ] || [ "$hook" = pre-push ] || [ "$hook" = post-rewrite ]; then
  if [ "$hook" = pre-push ] && [ -z "\${LLV_STAGE_GIT_RECEIPT:-}" ]; then exec "$target" "$@"; fi
  printf '%s\\n' "$input" | "$target" "$@"
  # A slow repository hook may outlive this stage's worktree ownership.
  stage_owner_check "$@"
else
  exec "$target" "$@"
fi
`;
  const body = Buffer.from(script);
  const digest = crypto.createHash("sha256").update(body).digest("hex");
  const hash = digest.slice(0, 24);
  // CLI shims enter the host namespace. Only HOME is mounted at the same
  // writable path there; container /tmp is private and /var/tmp is read-only.
  const parent = path.resolve(source.HOME?.trim() || process.env.HOME?.trim() || os.homedir(), ".cache", "delegatus", "agent-git-hooks");
  let root = roots.get(parent);
  // A successor process may inherit a generated directory from its launcher.
  // Only reuse our exact layout and expected digest under this launch's HOME;
  // never repair an arbitrary path supplied as a guard directory.
  const inherited = source.LLV_AGENT_GIT_GUARD_DIR;
  if (!root && inherited && path.basename(inherited) === hash) {
    const candidate = path.dirname(inherited);
    if (path.dirname(candidate) === parent && /^guard-[A-Za-z0-9]+$/.test(path.basename(candidate))) {
      const entry = fs.lstatSync(candidate, { throwIfNoEntry: false });
      const directory = fs.lstatSync(inherited, { throwIfNoEntry: false });
      if (entry?.isDirectory() && directory?.isDirectory()) root = candidate;
    }
  }
  if (!root) {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    root = fs.mkdtempSync(path.join(parent, "guard-"));
  }
  const rootEntry = fs.lstatSync(root, { throwIfNoEntry: false });
  if (rootEntry && !rootEntry.isDirectory()) throw new Error("Invalid generated Git hook root");
  roots.set(parent, root);
  const directory = path.join(root, hash);
  const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (existing && !existing.isDirectory()) throw new Error("Invalid generated Git hook directory");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const hook of hooks) {
    const target = path.join(directory, hook);
    if (verifiedHook(target, body, digest)) continue;
    const pending = target + "." + crypto.randomUUID();
    try {
      fs.writeFileSync(pending, body, { mode: 0o700, flag: "wx" });
      fs.renameSync(pending, target);
    } finally { fs.rmSync(pending, { force: true }); }
    if (existing) console.warn(`Delegatus: repaired generated Git hook ${hook}; expected sha256 ${digest}`);
  }
  const stageBinding = source.LLV_STAGE_GIT_RECEIPT ? {
    LLV_STAGE_GIT_RECEIPT: source.LLV_STAGE_GIT_RECEIPT,
    LLV_STAGE_GIT_WORKTREE: source.LLV_STAGE_GIT_WORKTREE,
  } : {};
  return { ...env, ...stageBinding, GIT_CONFIG_COUNT: String(count + 1), [`GIT_CONFIG_KEY_${count}`]: "core.hooksPath",
    [`GIT_CONFIG_VALUE_${count}`]: directory, LLV_AGENT_GIT_GUARD_DIR: directory };
}
