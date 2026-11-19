import type { ForgeCacheFile, ForgeRepositoryEntry } from "./cache";

/*
 * A synthetic forge cache shaped like the one on a busy installation
 * (2026-11-12: 2.6 MB, 8 repositories, 6,557 pull requests, two repositories
 * holding about 2,700 and 2,500 of them, 110 numbers known to be issues, a
 * proposal page of up to 40 issues per seated repository). Every repository,
 * branch, title and commit is invented.
 */
const SHAPE: { prs: number; issues: number; proposals: number }[] = [
  { prs: 2_726, issues: 30, proposals: 40 },
  { prs: 2_549, issues: 80, proposals: 40 },
  { prs: 892, issues: 0, proposals: 40 },
  { prs: 232, issues: 0, proposals: 18 },
  { prs: 137, issues: 0, proposals: 4 },
  { prs: 17, issues: 0, proposals: 0 },
  { prs: 3, issues: 0, proposals: 0 },
  { prs: 1, issues: 0, proposals: 0 },
];

export function syntheticForgeCache(now = Date.parse("2026-11-12T12:00:00Z")): ForgeCacheFile {
  const repositories: Record<string, ForgeRepositoryEntry> = {};
  SHAPE.forEach((shape, repository) => {
    const name = `example-org/repository-${repository}`;
    const at = (minutes: number) => new Date(now - minutes * 60_000).toISOString();
    const prs: ForgeRepositoryEntry["prs"] = {};
    for (let number = 1; number <= shape.prs; number += 1) {
      const merged = number % 5 !== 0;
      prs[String(number)] = {
        url: `https://github.com/${name}/pull/${number}`,
        headRefName: `pipeline/lane-${repository}-${number}`,
        createdAt: at(shape.prs - number + 60),
        state: merged ? "merged" : number % 3 === 0 ? "closed" : "open",
        closes: number % 4 === 0 ? [number + 100_000] : [],
        checkedAt: at(3),
        headRefOid: (number * 2_654_435_761 % 2 ** 32).toString(16).padStart(8, "0").repeat(5),
        title: `Invented change ${number} in repository ${repository}: a title of the usual length`,
        ...(merged ? { mergedAt: at(shape.prs - number + 30) } : {}),
      };
    }
    const issues: ForgeRepositoryEntry["issues"] = {};
    for (let index = 0; index < shape.issues; index += 1) issues[String(100_000 + index)] = { checkedAt: at(index) };
    repositories[name] = {
      canonical: name,
      completeSince: at(60 * 24 * 30),
      lastSweepAt: at(3),
      lastAttemptAt: at(3),
      lastError: null,
      prs,
      issues,
      ...(shape.proposals ? { proposals: { checkedAt: at(3), issues: Array.from({ length: shape.proposals }, (_, index) => ({
        number: 200_000 + index, title: `Invented proposal ${index}`, labels: ["proposal"], updatedAt: at(index * 10), checkedAt: at(3),
      })) } } : {}),
      headRefOids: true,
    };
  });
  return { schemaVersion: 1, repositories };
}
