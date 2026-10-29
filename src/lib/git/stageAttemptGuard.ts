import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { statePath } from "@/lib/configDir";
import type { ExecPort } from "@/lib/workflows/provision";

export function stageGitReceiptDirectory(launchId: string): string {
  return statePath("pipeline-git-attempts", crypto.createHash("sha256").update(launchId).digest("hex"));
}

/** Rehost the original attempt without claiming or refreshing its start head.
 * The launch id selects the receipt; a worktree's newest owner alone must
 * never grant an older conversation the successor's binding. */
export async function restoreStageGitGuard(launchId: string | null | undefined, worktree: string, exec: ExecPort): Promise<Record<string, string>> {
  if (!launchId) return {};
  const directory = stageGitReceiptDirectory(launchId);
  let start: { launchId?: string; worktree?: string };
  try { start = JSON.parse(await fs.readFile(path.join(directory, "start.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error; }
  if (start.launchId !== launchId || start.worktree !== worktree) throw new Error("stage Git rehost binding does not match its launch");
  const gitDirectory = await exec("git", ["rev-parse", "--absolute-git-dir"], worktree);
  if (gitDirectory.code !== 0 || !path.isAbsolute(gitDirectory.stdout.trim())) throw new Error("stage Git rehost cannot read the worktree Git directory");
  const ownerFile = path.join(gitDirectory.stdout.trim(), "delegatus-stage-owner");
  if (await fs.readFile(path.join(directory, "owner"), "utf8") !== ownerFile
    || await fs.readFile(ownerFile, "utf8") !== directory) throw new Error("stage Git rehost was superseded by another attempt");
  return { LLV_STAGE_GIT_RECEIPT: directory, LLV_STAGE_GIT_WORKTREE: worktree };
}

export async function prepareStageGitGuard(launchId: string, worktree: string, exec: ExecPort, now: string, assertActivation: () => void | Promise<void>): Promise<Record<string, string>> {
  const directory = stageGitReceiptDirectory(launchId);
  const gitDirectory = await exec("git", ["rev-parse", "--absolute-git-dir"], worktree);
  if (gitDirectory.code !== 0 || !path.isAbsolute(gitDirectory.stdout.trim())) throw new Error("stage Git guard cannot read the worktree Git directory");
  // A linked worktree owns its own Git directory. Removing it also removes
  // this fence; sibling worktrees and unrelated fixture repositories keep theirs.
  const ownerFile = path.join(gitDirectory.stdout.trim(), "delegatus-stage-owner");
  const readOwner = async () => {
    try { return await fs.readFile(ownerFile, "utf8"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  };
  // The Git-directory lookup can outlive the activation that authorized this
  // preparation. Never adopt a successor as our expected predecessor.
  await assertActivation();
  const previousOwner = await readOwner();
  const head = await exec("git", ["rev-parse", "HEAD"], worktree);
  if (head.code !== 0 || !/^[0-9a-f]{40}$/.test(head.stdout.trim())) throw new Error("stage Git guard cannot read the starting head");
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  let start = { launchId, worktree, head: head.stdout.trim(), startedAt: now, commitReceiptVersion: 1, previousOwner };
  try { await fs.writeFile(path.join(directory, "start.json"), JSON.stringify(start), { flag: "wx", mode: 0o600 }); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const prior = JSON.parse(await fs.readFile(path.join(directory, "start.json"), "utf8"));
    if (prior.launchId !== launchId || prior.worktree !== worktree || prior.head !== start.head) throw new Error("stage Git guard starting head changed before dispatch");
    start = prior;
  }
  // Plain files let the native hooks run without starting another interpreter.
  await fs.writeFile(path.join(directory, "base"), start.head, { mode: 0o600 });
  // Git's lock-file convention supplies exclusive admission and an atomic
  // handoff. A replay can finish its own interrupted claim, never reclaim a
  // worktree another attempt has since taken.
  const lock = ownerFile + ".lock";
  const handle = await fs.open(lock, "wx", 0o600);
  let handedOver = false;
  try {
    // Recheck durable activation under the exclusive claim lock, before any
    // owner mutation. The saved predecessor also fences interrupted replays.
    await assertActivation();
    const current = await readOwner();
    if (current !== directory && current !== (start.previousOwner ?? null)) throw new Error("stage Git guard was superseded by another attempt");
    await fs.writeFile(path.join(directory, "owner"), ownerFile, { mode: 0o600 });
    await handle.writeFile(directory);
    await handle.close();
    await fs.rename(lock, ownerFile);
    handedOver = true;
  } finally { await handle.close(); if (!handedOver) await fs.rm(lock, { force: true }); }
  return { LLV_STAGE_GIT_RECEIPT: directory, LLV_STAGE_GIT_WORKTREE: worktree };
}

/** These receipts attest cooperating stage commands, like the author guard.
 * They grant no authority to arbitrary remote commits or later review repair. */
export function stageAttemptGuardScript(): string {
  return `
stage_owner_check() { :; }
stage_receipt=\${LLV_STAGE_GIT_RECEIPT:-}
stage_worktree=\${LLV_STAGE_GIT_WORKTREE:-}
if [ -z "$stage_receipt" ] || [ -z "$stage_worktree" ]; then
  # The per-worktree owner survives a lost environment. Diagnose at the hook
  # boundary, before a mutation can silently lose its creation receipt.
  stage_git_dir=$(git rev-parse --absolute-git-dir 2>/dev/null) || stage_git_dir=
  if [ -n "$stage_git_dir" ] && [ -f "$stage_git_dir/delegatus-stage-owner" ]; then
    diagnostic_receipt=$(cat "$stage_git_dir/delegatus-stage-owner") || exit 1
    missing=
    [ -n "$stage_receipt" ] || missing="LLV_STAGE_GIT_RECEIPT"
    [ -n "$stage_worktree" ] || missing="$missing LLV_STAGE_GIT_WORKTREE"
    case "$diagnostic_receipt" in /*)
      printf '%s\\n' "hook=$hook missing=$missing" > "$diagnostic_receipt/binding-diagnostics" || exit 1 ;;
    esac
    echo "stage Git guard missing binding:$missing (hook $hook)" >&2
    exit 1
  fi
fi
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
stage_owner_check() {
  # Only lane mutations need the fence. Fetches and unrelated fixture repos
  # retain their repository hooks and ordinary argv/stdin.
  if [ "$hook" = pre-push ] || { [ "$hook" = reference-transaction ] && [ "\${1:-}" = prepared ] && printf '%s\\n' "$input" | grep -Eq ' (HEAD|refs/heads/[^ ]+)$'; }; then
    current_common=$(git rev-parse --path-format=absolute --git-common-dir) || stage_refuse
    owned_common=$(lane_git rev-parse --path-format=absolute --git-common-dir) || stage_refuse
    if [ "$current_common" = "$owned_common" ] && [ -f "$receipt/owner" ]; then
      owner_file=$(cat "$receipt/owner") || stage_refuse
      owner=$(cat "$owner_file") || owner=
      if [ "$owner" != "$receipt" ]; then
        echo 'stage Git mutation refused: a successor owns this worktree; new work requires a new stage and review' >&2
        exit 1
      fi
    fi
  fi
}
stage_owner_check "$@"
# The Git process that runs a hook is its parent. Its PID with its start time
# names one invocation, so a recorded intent cannot outlive it into a later one.
invocation() {
  started=$(cut -d' ' -f22 2>/dev/null < "/proc/$PPID/stat" | tr -dc '0-9') || started=
  [ -n "$started" ] || started=$(ps -o lstart= -p "$PPID" 2>/dev/null | tr -c 'A-Za-z0-9\\n' '_') || started=
  [ -n "$started" ] || return 1
  printf '%s-%s\\n' "$PPID" "$started"
}
if [ "$hook" = reference-transaction ] && [ "\${1:-}" = prepared ] && process=$(invocation) && [ -f "$receipt/intents/$process" ]; then
  # The commit or merge invocation whose prepare-commit-msg recorded this
  # intent is now moving a branch, before the ref update and before any kill
  # can skip post-commit or post-merge. Only the commit it is writing, with
  # exactly the intent's tree and parents, gets a receipt. An invocation that
  # aborted (editor, commit-msg, author check) never reaches this point, and
  # a later reset, update-ref or unguarded commit is another process.
  # Each line of the intent is one parent set Git may record for it.
  intent=$(cat "$receipt/intents/$process") || intent=
  if [ -n "$intent" ]; then
    printf '%s\\n' "$input" | while read -r old new ref; do
      case "$ref" in HEAD|refs/heads/*) ;; *) continue ;; esac
      case "$new" in *[!0-9a-f]*|'') continue ;; esac
      [ "\${#new}" = 40 ] || continue
      made=$(git show -s --no-show-signature --format='%T %P' "$new" 2>/dev/null) || continue
      printf '%s\\n' "$intent" | grep -qxF "$(printf '%s' "\${made% }" | tr ' ' '-')" || continue
      mkdir -p "$receipt/commits" && : > "$receipt/commits/$new"
      # One intent proves one commit.
      rm -f "$receipt/intents/$process"
    done
  fi
fi
if [ "$hook" = post-commit ] || [ "$hook" = post-merge ] || [ "$hook" = post-applypatch ] || [ "$hook" = post-rewrite ] || [ "$hook" = prepare-commit-msg ]; then
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
    if [ "$owned" = true ] && [ "$hook" = prepare-commit-msg ]; then
      # Commit and merge run this before the commit object and the ref update
      # exist, --no-verify included, and the same process later runs the
      # reference-transaction hook above. Record the tree and parents it is
      # about to commit under that process. Never refuse the commit here.
      index=\${GIT_INDEX_FILE:-$(git rev-parse --git-path index)}
      if process=$(invocation) && mkdir -p "$receipt/intents" && copy=$(mktemp "$receipt/intents/.index-XXXXXX"); then
        if cp "$index" "$copy" && tree=$(GIT_INDEX_FILE=$copy git write-tree 2>/dev/null); then
          intent=$tree
          if parent=$(git rev-parse -q --verify HEAD); then intent=$intent-$parent; else parent=; fi
          merges=
          subsumed=false
          merge_file=$(git rev-parse --git-path MERGE_HEAD) || merge_file=
          if [ -n "$merge_file" ] && [ -f "$merge_file" ]; then
            while read -r merged; do
              merges=$merges-$merged
              [ -z "$parent" ] || ! git merge-base --is-ancestor "$parent" "$merged" 2>/dev/null || subsumed=true
            done < "$merge_file"
          fi
          intent=$intent$merges
          # Without --no-ff Git leaves out a HEAD that one of the merged heads
          # already contains, as in an octopus merge over the lane's own work.
          [ "$subsumed" = false ] || intent=$(printf '%s\\n%s' "$intent" "$tree$merges")
          printf '%s\\n' "$intent" > "$copy" && mv "$copy" "$receipt/intents/$process" 2>/dev/null || :
        fi
        rm -f "$copy"
      fi
    elif [ "$owned" = true ]; then
      mkdir -p "$receipt/commits"
      if [ "$hook" = post-rewrite ]; then
        printf '%s\\n' "$input" | while read -r old made rest; do
          case "$made" in *[!0-9a-f]*|'') exit 1 ;; esac
          [ "\${#made}" = 40 ] || exit 1
          : > "$receipt/commits/$made"
        done || exit 1
      elif [ "$hook" = post-merge ]; then
        # Git retains MERGE_HEAD through post-merge only when this invocation
        # created a merge. Fast-forwards to existing merges have no merge state.
        merge_file=$(git rev-parse --git-path MERGE_HEAD) || exit 1
        if [ -f "$merge_file" ] && git rev-parse --verify -q HEAD^2 >/dev/null; then
          made=$(git rev-parse HEAD) || exit 1
          : > "$receipt/commits/$made"
        fi
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
