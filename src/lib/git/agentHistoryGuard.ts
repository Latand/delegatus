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

/** Git's transaction hook can refuse an amend even with --no-verify or
 * --reset-author. Scope it to the child environment; preserve repository hooks
 * and config, and refuse branch-history replacements that discard another author.
 * This is a cooperative agent guard, not a sandbox against hostile shell code.
 */
export function agentHistoryGuardEnv(source: AgentEnvironment, name: string, email: string): Record<string, string | undefined> {
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
  echo "Delegatus: refusing to rewrite a commit whose author is not this machine identity; add a new commit on top instead." >&2
  exit 1
}
check_author() {
  author=$(git show -s --no-show-signature --no-color --no-notes --format='%an%n%ae' "$1") || refuse
  [ "$author" = ${quote(name + "\n" + email)} ] || refuse
}
hook=\${0##*/}
if [ "$hook" = prepare-commit-msg ]; then
  # commit exports its effective author, including -C/-c inheritance. The
  # cherry-pick sequencer needs its own source check. --no-verify runs this hook.
  identity=$(git var GIT_AUTHOR_IDENT) || refuse
  [ "\${identity%>*}>" = ${quote(name + " <" + email + ">")} ] || refuse
  if picked=$(git rev-parse --verify -q CHERRY_PICK_HEAD); then check_author "$picked"; fi
fi
if [ "$hook" = pre-applypatch ]; then
  # am keeps its author in the sequencer's quoted data, rather than exporting
  # it to hooks. Compare those assignments literally; never source the file.
  author_file=$(git rev-parse --git-path rebase-apply/author-script) || refuse
  author_data=$(sed -n '1,2p' "$author_file") || refuse
  [ "$author_data" = ${quote("GIT_AUTHOR_NAME=" + quote(name) + "\nGIT_AUTHOR_EMAIL=" + quote(email))} ] || refuse
fi
if [ "$hook" = reference-transaction ]; then
  input=$(cat)
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
          *[!0]*) [ "$parents" != "$old" ] || check_author "$new" ;;
          *) check_author "$new" ;;
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
[ -x "$target" ] || exit 0
if [ "$hook" = reference-transaction ]; then
  printf '%s\\n' "$input" | "$target" "$@"
else
  exec "$target" "$@"
fi
`;
  const hash = crypto.createHash("sha256").update(script).digest("hex").slice(0, 24);
  // CLI shims enter the host namespace. Only HOME is mounted at the same
  // writable path there; container /tmp is private and /var/tmp is read-only.
  const parent = path.join(source.HOME?.trim() || os.homedir(), ".cache", "delegatus", "agent-git-hooks");
  let root = roots.get(parent);
  if (!root) {
    fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
    root = fs.mkdtempSync(path.join(parent, "guard-"));
    roots.set(parent, root);
  }
  const directory = path.join(root, hash);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const hook of hooks) {
    const target = path.join(directory, hook);
    if (fs.existsSync(target)) continue;
    const pending = target + "." + crypto.randomUUID();
    fs.writeFileSync(pending, script, { mode: 0o700, flag: "wx" });
    fs.renameSync(pending, target);
  }
  return { ...env, GIT_CONFIG_COUNT: String(count + 1), [`GIT_CONFIG_KEY_${count}`]: "core.hooksPath",
    [`GIT_CONFIG_VALUE_${count}`]: directory, LLV_AGENT_GIT_GUARD_DIR: directory };
}
