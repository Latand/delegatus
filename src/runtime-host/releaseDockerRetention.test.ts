import { expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { releaseBuilderName, viewerCandidateContainerName, viewerCandidateImageName } from "./deploymentArtifacts";
import { ensureReleaseBuilder, retainReleaseDockerData } from "./releaseDockerRetention";

test("successive updates bound eligible cache and images while a protected release exceeds the budget", async () => {
  const state = fs.mkdtempSync(path.join(os.tmpdir(), "release-cache-"));
  const builder = releaseBuilderName(state), now = 2_000_000, started = now - 100_000;
  const make = (key: string, sha: string) => {
    const container = viewerCandidateContainerName(key);
    fs.mkdirSync(path.join(state, "deployments", key), { recursive: true });
    return { container, image: viewerCandidateImageName(sha.repeat(40), container), id: "sha256:" + sha.repeat(64) };
  };
  try {
    const current = make("today", "a"), rollback = make("yesterday", "b"), obsolete = make("old", "c");
    fs.writeFileSync(path.join(state, "deployments/today/docker-build.json"), JSON.stringify({ builder, image: current.image, startedAt: started }));
    const images = new Set([current, rollback, obsolete]);
    const cache = [{ used: started - 2, bytes: 8192 }, { used: started - 1, bytes: 2048 }, { used: started + 1, bytes: 512 }];
    const docker = async (args: string[]) => {
      const [kind, action] = args;
      if (kind === "buildx" && action === "prune") {
        expect(args[args.indexOf("--builder") + 1]).toBe(builder);
        const age = /^until=(\d+)s$/.exec(args[args.indexOf("--filter") + 1]!)!;
        const threshold = now - Number(age[1]) * 1000, limit = Number(args[args.indexOf("--max-used-space") + 1]);
        while (cache[0] && cache[0].used < threshold && cache.reduce((sum, row) => sum + row.bytes, 0) > limit) cache.shift();
      } else if (action === "inspect") return [...images].filter(image => args.includes(image.image)).map(image => image.id).join("\n");
      else if (action === "ls") return [...images].map(image => `${image.id} ${image.image}`).join("\n");
      else if (action === "rm") {
        const image = [...images].find(row => row.image === args[2])!;
        expect(image).toBe(obsolete);
        images.delete(image);
      } else throw new Error("unexpected fixture command");
      return "";
    };
    for (const removed of [1, 0]) {
      expect(await retainReleaseDockerData(state, [current, rollback], docker, "1024", () => now)).toMatchObject({ removed });
      expect([...images]).toEqual([current, rollback]);
      expect(cache).toEqual([{ used: started + 1, bytes: 512 }]);
    }
    await expect(retainReleaseDockerData(state, [current, rollback], async () => { throw new Error("unexpected command"); }, "-1", () => now))
      .rejects.toThrow("invalid release build cache budget");
  } finally { fs.rmSync(state, { recursive: true, force: true }); }
});

test("first build creates a private builder without switching the operator's selected builder", async () => {
  const calls: string[][] = [], state = "/fixture/state", builder = releaseBuilderName(state);
  await ensureReleaseBuilder(state, async args => {
    calls.push(args);
    if (args[1] === "inspect") throw new Error("missing builder");
    return builder;
  });
  expect(calls).toEqual([["buildx", "inspect", builder], ["buildx", "create", "--name", builder, "--driver", "docker-container"]]);
});
