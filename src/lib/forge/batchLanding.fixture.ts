import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

/** Real histories behind the forge replies, with another lane after the
 * reviewed patch lands. */
export function batchLandingFixture(root: string, kind = "rebased") {
  const directory = fs.mkdtempSync(path.join(root, "batch-git-"));
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", "-c", "core.fileMode=true", ...args], {
    cwd: directory, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GIT_AUTHOR_NAME: "Fixture", GIT_COMMITTER_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture.invalid", GIT_COMMITTER_EMAIL: "fixture.invalid",
      GIT_AUTHOR_DATE: "2026-10-11T04:18:00Z", GIT_COMMITTER_DATE: "2026-10-11T04:18:00Z",
      GIT_CONFIG_COUNT: "0" },
  }).trim();
  const commit = (file: string, content: string | Uint8Array) => {
    fs.writeFileSync(path.join(directory, file), content);
    git("add", file);
    git("commit", "-m", `Change ${file}`);
    return git("rev-parse", "HEAD");
  };
  git("init", "-b", "main");
  const binary = kind.includes("binary");
  const mode = kind.includes("mode");
  const deletion = kind.includes("deletion");
  const lines = Array.from({ length: 20 }, (_, index) => `line ${index}\n`).join("");
  const section = Array.from({ length: 17 }, (_, index) => `${index === 8 ? "disabled" : `section line ${index}`}\n`).join("");
  const repeated = kind === "wrong-occurrence";
  const before = binary ? Buffer.from([0, 1, 2]) : repeated ? section.repeat(2) : lines + "disabled\n";
  const after = binary ? Buffer.from([0, 1, 3]) : repeated ? section.replace("disabled", "enabled") + section : lines + "enabled\n";
  commit("feature", before);
  if (kind === "partial-revert") commit("companion", "disabled\n");
  git("checkout", "-b", "lane");
  if (deletion) git("rm", "feature");
  else {
    if (mode) fs.chmodSync(path.join(directory, "feature"), 0o755);
    fs.writeFileSync(path.join(directory, "feature"), mode ? before : after);
    git("add", "feature");
  }
  if (kind === "partial-revert") {
    fs.writeFileSync(path.join(directory, "companion"), "enabled\n");
    git("add", "companion");
  }
  git("commit", "-m", "Reviewed feature patch");
  let head = git("rev-parse", "HEAD");
  git("checkout", "main");
  commit("before", "another lane\n");
  const carrier = kind.startsWith("carrier-");
  const mergeWork = kind.startsWith("carrier-merge");
  if (carrier) git("checkout", "-b", "integration/widgets");
  if (kind === "nearby-rebase") commit("feature", String(before).replace("line 17", "updated line 17"));
  if (kind === "offset-rebase") commit("feature", "main inserted a line\n" + before);
  if (kind === "wrong-occurrence") commit("feature", section + section.replace("disabled", "enabled"));
  else if (kind === "wrong-sha") commit("unrelated", "different patch\n");
  else if (mergeWork) git("merge", "--no-ff", "-m", "Merge reviewed work", "lane");
  else git("cherry-pick", head);
  const landing = git("rev-parse", "HEAD");
  if (kind.endsWith("-reverted-before") || kind === "carrier-restored-later") {
    git("revert", "--no-edit", ...(mergeWork ? ["-m", "1"] : []), landing);
  }
  commit("after", "last lane in batch\n");
  if (carrier) {
    git("checkout", "main");
    git("merge", "--no-ff", "-m", "Land integration branch", "integration/widgets");
  }
  const tip = git("rev-parse", "HEAD");
  commit("later", "main advanced after the batch\n");
  if (kind === "carrier-restored-later") git("cherry-pick", landing);
  if (kind.startsWith("reverted") || kind === "carrier-reverted-after") git("revert", "--no-edit", landing);
  if (kind === "partial-revert") commit("feature", before);
  if (kind === "followup") commit("feature", String(after).replace("line 0", "updated line 0"));
  if (kind === "new-head" || kind === "whitespace") {
    git("checkout", "lane");
    head = commit("feature", lines + (kind === "whitespace" ? "enabled \n" : "enabled v2\n"));
    git("checkout", "main");
  }
  let outputHead: string | null = null;
  if (kind.includes("local-output")) {
    git("checkout", "lane");
    outputHead = commit("result.md", "Review audit\n");
    git("checkout", "main");
  }
  return { directory, head, outputHead, landing, tip, base: git("rev-parse", "HEAD"), git };
}
