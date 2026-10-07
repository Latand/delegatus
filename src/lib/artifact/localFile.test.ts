import { afterEach, expect, spyOn, test } from "bun:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { descriptorPlace, openAdmitted, openedAt } from "./localFile";

/* Where an open file lies, asked of the platform this run is on. Linux and
   macOS each have their own mechanism, so the same cases run on both. */

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });

async function layout() {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "llv-place-")));
  roots.push(root);
  for (const name of ["inside", "outside"]) {
    await fs.mkdir(path.join(root, name));
    await fs.writeFile(path.join(root, name, "shot.png"), name);
  }
  await fs.symlink(path.join(root, "outside"), path.join(root, "link"));
  return { inside: path.join(root, "inside", "shot.png"), outside: path.join(root, "outside", "shot.png"), linked: path.join(root, "link", "shot.png") };
}

/** The kernel's names for open files are gone for as long as `run` takes. */
async function withoutDescriptorNames(run: () => Promise<void>) {
  const readlink = fs.readlink.bind(fs);
  const spy = spyOn(fs, "readlink").mockImplementation((async (file: never, ...rest: never[]) => {
    if (String(file).startsWith("/proc/self/fd/")) throw Object.assign(new Error("no such file or directory"), { code: "ENOENT" });
    return readlink(file, ...rest);
  }) as never);
  try { await run(); } finally { spy.mockRestore(); }
}

const named = process.platform === "linux" || process.platform === "darwin";

test.skipIf(!named)("a file opened at its own place is found there, and its bytes are read", async () => {
  const { inside } = await layout();
  const handle = await openAdmitted(inside);
  try {
    expect(await openedAt(handle, inside)).toBe(true);
    expect((await handle.readFile()).toString()).toBe("inside");
  } finally { await handle.close(); }
});

test.skipIf(!named)("a file opened through a linked directory, or lying elsewhere under the same name, is not at the expected place", async () => {
  const { inside, outside, linked } = await layout();
  const through = await fs.open(linked, "r");
  const elsewhere = await fs.open(outside, "r");
  try {
    expect(await descriptorPlace(through, linked)).toBe(false);
    expect(await openedAt(through, linked)).toBe(false);
    expect(await descriptorPlace(elsewhere, inside)).toBe(false);
  } finally { await through.close(); await elsewhere.close(); }
  await expect(openAdmitted(linked)).rejects.toMatchObject({ code: "ELOOP" });
});

test.skipIf(process.platform !== "linux")("with no name from the kernel the place is unknown, and nothing is opened or published on that ground", async () => {
  const { inside } = await layout();
  await withoutDescriptorNames(async () => {
    const handle = await fs.open(inside, "r");
    try {
      expect(await descriptorPlace(handle, inside)).toBeNull();
      expect(await openedAt(handle, inside)).toBe(false);
      /* The macOS mechanism is trusted only where an open refuses a linked
         directory; this kernel ignores the flag, so it is not used. */
      expect(await descriptorPlace(handle, inside, "darwin")).toBeNull();
    } finally { await handle.close(); }
    await expect(openAdmitted(inside)).rejects.toMatchObject({ code: "ELOOP" });
    await expect(openAdmitted(inside, "darwin")).rejects.toMatchObject({ code: "ELOOP" });
  });
});

test.skipIf(process.platform !== "linux")("Windows, which has no mechanism, keeps reading an ordinary file by its path and still refuses a linked one", async () => {
  const { inside, linked } = await layout();
  await withoutDescriptorNames(async () => {
    const handle = await openAdmitted(inside, "win32");
    try { expect((await handle.readFile()).toString()).toBe("inside"); expect(await openedAt(handle, inside)).toBe(false); } finally { await handle.close(); }
    const through = await fs.open(linked, "r");
    try { expect(await descriptorPlace(through, linked, "win32")).toBeNull(); } finally { await through.close(); }
    await expect(openAdmitted(linked, "win32")).rejects.toMatchObject({ code: "ELOOP" });
  });
});
