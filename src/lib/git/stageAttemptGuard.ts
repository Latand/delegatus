import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import type { ExecPort } from "@/lib/workflows/provision";

export function stageGitReceiptDirectory(launchId: string): string {
  return statePath("pipeline-git-attempts", crypto.createHash("sha256").update(launchId).digest("hex"));
}

export async function prepareStageGitGuard(launchId: string, worktree: string, exec: ExecPort, now: string): Promise<Record<string, string>> {
  const directory = stageGitReceiptDirectory(launchId);
  const head = await exec("git", ["rev-parse", "HEAD"], worktree);
  if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(head.stdout.trim())) throw new Error("stage Git guard cannot read the starting head");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const start = { launchId, worktree, head: head.stdout.trim(), startedAt: now, commitReceiptVersion: 1 };
  try { await fs.writeFile(path.join(directory, "start.json"), JSON.stringify(start), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const prior = JSON.parse(await fs.readFile(path.join(directory, "start.json"), "utf8"));
    if (prior.launchId !== launchId || prior.worktree !== worktree || prior.head !== start.head) throw new Error("stage Git guard starting head changed before dispatch");
  }
  // Plain files let the native hooks run without starting another interpreter.
  await fs.writeFile(path.join(directory, "base"), start.head, { mode: 0o600 });
  return { LLV_STAGE_GIT_RECEIPT: directory, LLV_STAGE_GIT_WORKTREE: worktree };
}

/** These receipts attest cooperating stage commands, like the author guard.
 * They grant no authority to arbitrary remote commits or later review repair. */
export function stageAttemptGuardScript(): string {
  return `
stage_receipt=\${LLV_STAGE_GIT_RECEIPT:-}
stage_worktree=\${LLV_STAGE_GIT_WORKTREE:-}
if [ -n "$stage_receipt" ] || [ -n "$stage_worktree" ]; then
  case "$stage_receipt:$stage_worktree" in /*:/*) ;; *) echo 'Invalid stage Git guard binding' >&2; exit 1 ;; esac
  receipt=$stage_receipt
  lane=$stage_worktree
  scratch=\${TMPDIR:-}
lane_git() (
  unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_PREFIX
  git -C "$lane" "$@"
)
stage_refuse() {
  unproved=\${1:-$(git rev-parse HEAD 2>/dev/null || printf unknown)}
  printf '%s\\n' "stage push refused: commit $unproved was not created in the attempt worktree during this attempt; commit in the lane worktree and let Delegatus publish" > "$receipt/refused"
  cat "$receipt/refused" >&2
  exit 1
}
if [ "$hook" = post-commit ] || [ "$hook" = post-merge ] || [ "$hook" = post-applypatch ] || [ "$hook" = post-rewrite ]; then
  common=$(git rev-parse --path-format=absolute --git-common-dir) || exit 1
  lane_common=$(lane_git rev-parse --path-format=absolute --git-common-dir) || exit 1
  if [ "$common" = "$lane_common" ]; then
    producer=$(git rev-parse --show-toplevel) || exit 1
    owned=false
    [ "$producer" != "$lane" ] || owned=true
    if [ -n "$scratch" ]; then
      scratch=$(cd "$scratch" && pwd -P) || exit 1
      case "$producer/" in "$scratch/"*) owned=true ;; esac
    fi
    if [ "$owned" = true ]; then
      mkdir -p "$receipt/commits"
      if [ "$hook" = post-rewrite ]; then
        printf '%s\\n' "$input" | while read -r old made rest; do
          case "$made" in *[!0-9a-f]*|'') exit 1 ;; esac
          [ "\${#made}" = 40 ] || exit 1
          : > "$receipt/commits/$made"
        done || exit 1
      elif [ "$hook" = post-merge ]; then
        # post-merge also runs after a fast-forward. Reflog action text comes
        # from GIT_REFLOG_ACTION, so only a real merge commit proves creation.
        parents=$(git rev-list --parents -n 1 HEAD) || exit 1
        set -- $parents
        if [ "$#" -ge 3 ]; then made=$1; : > "$receipt/commits/$made"; fi
      else
        made=$(git rev-parse HEAD) || exit 1
        : > "$receipt/commits/$made"
      fi
    fi
  fi
fi
if [ "$hook" = pre-push ]; then
  input=$(cat)
  common=$(git rev-parse --path-format=absolute --git-common-dir) || stage_refuse
  lane_common=$(lane_git rev-parse --path-format=absolute --git-common-dir) || stage_refuse
  lane_url=$(lane_git remote get-url --push origin 2>/dev/null) || lane_url=
  if [ "$common" = "$lane_common" ] || [ "$2" = "$lane_url" ]; then
  lane_head=$(lane_git rev-parse HEAD) || stage_refuse
  base=$(cat "$receipt/base") || stage_refuse
  [ "$common" = "$lane_common" ] || stage_refuse
  printf '%s\\n' "$input" | while read -r local_ref new remote_ref old; do
    case "$new" in *[!0]*) ;; *) continue ;; esac
    if [ "$new" != "$lane_head" ]; then
      git merge-base --is-ancestor "$base" "$new" || stage_refuse
      commits=$(git rev-list "$base..$new") || stage_refuse
      count=0
      for made in $commits; do
        count=$((count + 1))
        if [ ! -f "$receipt/commits/$made" ]; then
          # Imported upstream history is checked against the actual delivery
          # remote's base by the controller. A tracking ref only lets the
          # candidate reach that verification; it grants no adoption proof.
          published=$(git for-each-ref --contains="$made" --count=1 --format='%(refname)' refs/remotes/origin/) || stage_refuse "$made"
          [ -n "$published" ] || stage_refuse "$made"
        fi
      done
      [ "$count" -gt 0 ] || stage_refuse
    fi
    mkdir -p "$receipt/pushes"
    pending=$(mktemp "$receipt/pushes/.pending-XXXXXX") || stage_refuse
    printf '%s\\n%s\\n' "$remote_ref" "$2" > "$pending"
    mv "$pending" "$receipt/pushes/$new"
  done || exit 1
  fi
fi
fi
`;
}
