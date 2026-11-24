import { chmodSync, lstatSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, expect, spyOn, test } from "bun:test";
import { hostId } from "./hostId";
import { planFixture } from "./plan.fixture";
import { PlanStore } from "./store";

const fixture = () => scratch = planFixture();
let scratch: ReturnType<typeof planFixture>;
afterEach(() => scratch.dispose());

test("host identity survives new stores, atomic replacement, and owner-only permissions", async () => {
  const f = fixture();
  const host = await hostId(f.store);
  expect(await hostId(new PlanStore(() => f.directory))).toBe(host);
  const row = f.seed();
  const credentials = join(f.directory, "credentials.json");
  const previous = lstatSync(credentials);
  await f.store.transaction("credentials", async () => f.store.write("credentials", { ...row, acknowledged: true }));
  expect(lstatSync(credentials).ino).not.toBe(previous.ino);
  expect(lstatSync(credentials).mode & 0o777).toBe(0o600);
  expect(lstatSync(join(f.directory, "host.json")).mode & 0o777).toBe(0o600);
  expect(lstatSync(f.directory).mode & 0o777).toBe(0o700);
  expect(await f.store.credentials()).toMatchObject({ acknowledged: true });
  writeFileSync(join(f.directory, "host.json"), "{}");
  await expect(hostId(f.store)).rejects.toThrow("host_file");
  expect(readFileSync(join(f.directory, "host.json"), "utf8")).toBe("{}");
});

test.each(["mode", "link", "owner", "oversize", "malformed"])("refuses unsafe %s credentials without changing bytes", async kind => {
  const f = fixture();
  f.seed();
  const target = join(f.directory, "credentials.json");
  const original = join(f.directory, "other");
  if (kind === "mode") chmodSync(target, 0o640);
  if (kind === "link") { renameSync(target, original); symlinkSync(original, target); }
  if (kind === "oversize") writeFileSync(target, "x".repeat(65_537));
  if (kind === "malformed") writeFileSync(target, "{");
  const before = readFileSync(target);
  const actualUid = process.getuid?.();
  let inspected = 0;
  const uid = actualUid !== undefined && kind === "owner"
    ? spyOn(process, "getuid").mockImplementation(() => inspected++ === 0 ? actualUid : actualUid + 1) : undefined;
  try {
    if (kind === "owner" && !uid) return;
    await expect(f.store.credentials()).rejects.toThrow("credential_file");
    expect(readFileSync(target)).toEqual(before);
  } finally { uid?.mockRestore(); }
});
