import { expect, test } from "bun:test";
import { pipelinePublishesRemoteBranch } from "./publication";
import type { Pipeline } from "./types";

for (const [publication, disposition, remote, publishes] of [
  ["remote-branch", "owner", "", true],
  [undefined, "owner", "https://example.invalid/repo.git", true],
  [undefined, "owner", "", false],
  ["internal", "owner", "https://example.invalid/repo.git", false],
  [undefined, "comparison", "https://example.invalid/repo.git", false],
] as const) test(`publication ${publication ?? "implicit"}, ${disposition}, remote=${!!remote}`, () => {
  const delivery: NonNullable<Pipeline["delivery"]> = { target: { repository: "repo-fixture", branch: "refs/heads/lane", remote },
    disposition, publish: disposition === "owner" ? "enabled" : "disabled", active: disposition === "owner", ownerId: "lane", epoch: 1, journal: [] };
  expect(pipelinePublishesRemoteBranch({ publication, delivery })).toBe(publishes);
});
