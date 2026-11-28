import { expect, test } from "bun:test";
import fs from "node:fs/promises";
import path from "node:path";
import { realExec } from "@/lib/workflows/provision";
import { fixture, repositoryHooks, advanceMain, dieAfterRefUpdate } from "./stageAttemptPush.fixture";

test.each(["clean merge", "clean merge concluded by commit", "conflicted merge"] as const)(
  "a %s the attempt made just before its host died settles", async shape => {
    const f = await fixture();
    try {
      await fs.writeFile(path.join(f.lane, "shared.txt"), "lane\n");
      await f.own("add", "shared.txt");
      await f.commit("own work before the merge");
      if (shape === "conflicted merge") await advanceMain(f, "shared.txt", "main\n");
      else await advanceMain(f, "main.txt", "main\n");
      if (shape === "clean merge") await dieAfterRefUpdate(f, ["merge", "--no-ff", "--no-edit", "origin/main"]);
      else {
        const merged = await realExec("git", ["merge", "--no-ff", "--no-commit", "origin/main"], f.lane, f.env);
        expect(merged.code).toBe(shape === "conflicted merge" ? 1 : 0);
        if (shape === "conflicted merge") {
          await fs.writeFile(path.join(f.lane, "shared.txt"), "lane and main\n");
          await f.own("add", "shared.txt");
        }
        const message = path.join(f.root, "merge-message.txt");
        await fs.writeFile(message, "Merge origin/main into the lane\n\nCo-authored-by: Fixture <noreply@example.invalid>\n");
        await dieAfterRefUpdate(f, ["commit", "--cleanup=strip", "--file", message]);
      }
      const merge = await f.own("rev-parse", "HEAD");
      expect((await f.own("show", "-s", "--format=%P", merge)).split(" ")).toHaveLength(2);
      expect(await f.own("status", "--porcelain")).toBe("");
      const head = await f.commit("own fix after the merge");
      await f.push();
      expect(await f.settle()).toEqual({ ok: true, sha: head });
    } finally { await f.close(); }
  });

test.each(["ordinary commit", "clean merge"] as const)("%s under a command-line hooks path override settles with a creation receipt", async shape => {
  const f = await fixture();
  try {
    const withRepositoryHooks = await repositoryHooks(f);
    if (shape === "clean merge") await advanceMain(f, "main.txt", "main\n");
    const made = await withRepositoryHooks(shape === "clean merge" ? ["merge", "--no-ff", "--no-edit", "origin/main"]
      : ["commit", "--allow-empty", "-m", "own work, hooks path overridden"]);
    expect(made.code, made.stderr).toBe(0);
    const head = await f.own("rev-parse", "HEAD");
    expect(await fs.readFile(path.join(f.receipt, "commits", head), "utf8")).toBe("");
    await f.push();
    expect(await f.settle()).toEqual({ ok: true, sha: head });
  } finally { await f.close(); }
});
