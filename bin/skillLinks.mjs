/* Symlink every skill this repo ships (.claude/skills/*) into each installed
   agent's global skills dir, so one `git pull` propagates the skills to Claude
   and Codex at once — no per-agent copy to keep in sync.

   The links must point at a checkout that outlives the run. A pipeline lane
   runs the CLI from a linked worktree, and the hourly sweep deletes that
   worktree; links into it dangled and every Delegatus skill vanished. So the
   source is always the PRIMARY checkout: a linked worktree (its `.git` is a
   `gitdir:` file) resolves to the checkout that owns its git directory, and a
   checkout under the temp root is never a source. A transient npm/bunx install
   (no `.git`) links nothing.

   Only the names this repo ships are touched: a link that already points at
   the source stays, a link elsewhere (a live worktree, a dangling target) is
   re-pointed, and a pre-existing real copy is backed up once into
   `.skill-backups/`. Every other entry in the skills dir is left alone. */

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

function realOrSelf(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isInside(path, root) {
  const child = realOrSelf(path);
  const parent = realOrSelf(root);
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** The primary checkout behind `packageRoot`, or null when there is none that
    outlives this run (not a checkout, a bare repository, a temp directory). */
export function durableSkillCheckout(packageRoot, options = {}) {
  const tempRoot = options.tempRoot ?? tmpdir();
  const dotGit = join(packageRoot, ".git");
  let checkout;
  try {
    const stat = lstatSync(dotGit);
    if (stat.isDirectory()) {
      checkout = packageRoot;
    } else {
      /* Linked worktree: `.git` reads `gitdir: <common>/worktrees/<name>`, and
         that directory's `commondir` names the shared git directory. */
      const pointer = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
      if (!pointer) return null;
      const gitDir = isAbsolute(pointer) ? pointer : resolve(packageRoot, pointer);
      const commonRef = readFileSync(join(gitDir, "commondir"), "utf8").trim();
      const commonDir = isAbsolute(commonRef) ? commonRef : resolve(gitDir, commonRef);
      if (basename(commonDir) !== ".git") return null; // bare repository: no primary checkout
      checkout = dirname(commonDir);
    }
  } catch {
    return null;
  }
  if (!existsSync(join(checkout, ".git"))) return null;
  if (isInside(checkout, tempRoot)) return null;
  return checkout;
}

/** Best-effort; never throws for a single skill. */
export function linkSkills(packageRoot, options = {}) {
  const checkout = durableSkillCheckout(packageRoot, options);
  if (!checkout) return;
  const source = join(checkout, ".claude", "skills");
  let skills;
  try {
    skills = readdirSync(source, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  } catch {
    return;
  }
  if (skills.length === 0) return;
  const home = options.home ?? homedir();
  const roots = [join(home, ".claude", "skills"), join(home, ".codex", "skills")];
  for (const root of roots) {
    if (!existsSync(dirname(root))) continue; // that agent isn't installed
    try {
      mkdirSync(root, { recursive: true });
    } catch {
      continue;
    }
    for (const skill of skills) {
      const src = join(source, skill.name);
      const dest = join(root, skill.name);
      try {
        const stat = lstatSync(dest);
        if (stat.isSymbolicLink()) {
          try {
            if (realpathSync(dest) === realpathSync(src)) continue; // already linked here
          } catch {
            /* dangling link → relink below */
          }
          rmSync(dest);
        } else {
          /* Back up a pre-existing real copy into a hidden sibling dir so the
             skill loader (which scans visible subdirs for SKILL.md) never picks
             the backup up as a duplicate skill. */
          const backupDir = join(root, ".skill-backups");
          const backup = join(backupDir, skill.name);
          try {
            mkdirSync(backupDir, { recursive: true });
          } catch {
            /* fall through */
          }
          if (existsSync(backup)) rmSync(dest, { recursive: true, force: true });
          else renameSync(dest, backup);
        }
      } catch {
        /* dest is absent — fall through and create the link */
      }
      try {
        symlinkSync(src, dest, "dir");
      } catch {
        /* non-fatal: a single skill failing to link must not break launch */
      }
    }
  }
}
