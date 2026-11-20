import { expect, test } from "bun:test";
import { readDockerDiskConsumers } from "./dockerDiskConsumers";

test("the daemon totals include shared image layers once and the private builder volume separately", async () => {
  const docker = async (args: string[]) => args[0] === "system"
    ? "Images\t12.4GB\nLocal Volumes\t3GB\nBuild Cache\t512kB\n" : "Reclaimable: 1GB\nTotal: 2.5GB\n";
  expect(await readDockerDiskConsumers("/fixture/state", docker)).toEqual([
    { kind: "dockerImages", bytes: 12_400_000_000 }, { kind: "dockerCache", bytes: 2_500_512_000 },
  ]);
});

test("a legacy install reports its default builder and an unavailable daemon supplies no measurement", async () => {
  const missing = async () => { throw new Error("unavailable"); };
  expect(await readDockerDiskConsumers("/fixture/state", async args => args[0] === "system" ? "Build Cache\t0B" : missing()))
    .toEqual([{ kind: "dockerCache", bytes: 0 }]);
  expect(await readDockerDiskConsumers("/fixture/state", missing)).toEqual([]);
});
