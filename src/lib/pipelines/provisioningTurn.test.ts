import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { withProvisioningTurn } from "./provisioningTurn";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });
const wait = (predecessor: Promise<void>) => predecessor;

test("a second checkout can acquire the repository while the first prepares its toolchain", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "provision-turn-")); roots.push(root);
  const entered = Promise.withResolvers<void>(), nextGit = Promise.withResolvers<void>(), nextWaiting = Promise.withResolvers<void>();
  const finishGit = Promise.withResolvers<void>(), finishDeps = Promise.withResolvers<void>();
  let phase = "git";
  const first = withProvisioningTurn(root, path.join(root, "first"), wait, async ready => {
    entered.resolve(); await finishGit.promise; await mkdir(path.join(root, "first")); phase = "dependencies"; ready(); await finishDeps.promise; phase = "done";
  });
  await entered.promise;
  const second = withProvisioningTurn(root, path.join(root, "second"), predecessor => {
    nextWaiting.resolve(); return predecessor;
  }, async () => { expect(phase).toBe("dependencies"); nextGit.resolve(); });
  try {
    await nextWaiting.promise;
    expect(phase).toBe("git");
    finishGit.resolve();
    await Promise.race([nextGit.promise, second]);
  } finally {
    finishGit.resolve(); finishDeps.resolve(); await Promise.all([first, second]);
  }
});

test("a checkout reached through a directory alias waits for the previous preparation, including failure", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "provision-alias-")); roots.push(root);
  const alias = path.join(root, "alias");
  await symlink(root, alias, "dir");
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>(), blocked = Promise.withResolvers<void>();
  const first = withProvisioningTurn(root, path.join(root, "lane"), wait, async ready => {
    await mkdir(path.join(root, "lane")); ready(); entered.resolve(); await release.promise; throw new Error("failed dependency setup");
  });
  const observed = first.catch((error: Error) => error.message);
  await entered.promise;
  let nextEntered = false;
  const second = withProvisioningTurn(root, path.join(alias, "lane"), predecessor => {
    blocked.resolve(); return predecessor;
  }, async () => { nextEntered = true; });
  try { await Promise.race([blocked.promise, second]); expect(nextEntered).toBe(false); }
  finally { release.resolve(); await second; }
  expect(await observed).toBe("failed dependency setup");
  expect(nextEntered).toBe(true);
});
