import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { physicalProvisioningPath, provisioningStripe, tryProvisioningLock, type ProvisioningGrant } from "./provisionCheckoutCustody";

test.each([false, true])("the checkout turn outlives its repository turn through an alias (native %s)", async native => {
  if (native && process.platform === "win32") return;
  const root = await mkdtemp(path.join(os.tmpdir(), "provision-turn-"));
  const alias = path.join(root, "alias"), lane = path.join(root, "lane");
  const grants: ProvisioningGrant[] = [];
  const signal = new AbortController().signal;
  const lock = (kind: "checkout" | "repo", stripe: number) =>
    tryProvisioningLock(root, kind, stripe, native, signal, grant => grants.push(grant));
  try {
    await symlink(root, alias, "dir");
    const physical = await physicalProvisioningPath(lane);
    const stripe = provisioningStripe(physical);
    expect(await physicalProvisioningPath(path.join(alias, "lane"))).toBe(physical);
    const checkout = await lock("checkout", stripe);
    const repository = await lock("repo", stripe);
    expect(checkout).not.toBeNull();
    expect(repository).not.toBeNull();
    expect(await lock("checkout", stripe)).toBeNull();
    expect(await lock("repo", stripe)).toBeNull();
    await mkdir(lane);
    expect(await physicalProvisioningPath(path.join(alias, "lane"))).toBe(physical);
    repository!.close();
    expect(await lock("repo", stripe)).not.toBeNull();
    expect(await lock("checkout", stripe)).toBeNull();
    checkout!.close();
    expect(await lock("checkout", stripe)).not.toBeNull();
  } finally {
    for (const grant of grants) grant.close();
    await rm(root, { recursive: true, force: true });
  }
});
