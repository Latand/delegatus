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
  const start = { launchId, worktree, head: head.stdout.trim(), startedAt: now };
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

const quote = (s: string) => "'" + s.replaceAll("'", "'\\''") + "'";

/** These receipts attest cooperating stage commands, like the author guard.
 * They grant no authority to arbitrary remote commits or later review repair. */
export function stageAttemptGuardScript(source: Readonly<Record<string, string | undefined>>): string {
  const receipt = source.LLV_STAGE_GIT_RECEIPT;
  const worktree = source.LLV_STAGE_GIT_WORKTREE;
  if (!receipt && !worktree) return "";
  if (!receipt || !worktree || !path.isAbsolute(receipt) || !path.isAbsolute(worktree)) throw new Error("Invalid stage Git guard binding");
  return `
receipt=${quote(receipt)}
lane=${quote(worktree)}
scratch=${quote(source.TMPDIR ?? "")}
lane_git() (
  unset GIT_DIR GIT_WORK_TREE GIT_COMMON_DIR GIT_INDEX_FILE GIT_PREFIX
  git -C "$lane" "$@"
)
stage_refuse() {
  printf '%s\\n' 'stage push refused: commit outside the lane worktree has no proof from this attempt; commit in the lane worktree and let Delegatus publish' > "$receipt/refused"
  cat "$receipt/refused" >&2
  exit 1
}
if [ "$hook" = post-commit ]; then
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
      made=$(git rev-parse HEAD) || exit 1
      mkdir -p "$receipt/commits"
      : > "$receipt/commits/$made"
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
      commits=$(git rev-list --max-count=257 "$base..$new") || stage_refuse
      count=0
      for made in $commits; do
        count=$((count + 1))
        [ "$count" -le 256 ] && [ -f "$receipt/commits/$made" ] || stage_refuse
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
`;
}
