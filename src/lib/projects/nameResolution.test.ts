import { expect, test } from "bun:test";
import { indexedProjectResolver, namedProjectDirectory, ProjectNameRefusal, resolveNamedProject } from "./nameResolution";

const FIRST = "repo-12345678" + "a".repeat(24);
const SECOND = "repo-12345678" + "b".repeat(24);

test("bulk project resolution retains exact, normalized, prefix and ambiguous name behavior", () => {
  const directory = namedProjectDirectory({ includeActiveSeats: false, lastCompletedCatalog: () => ({
    files: [
      { project: FIRST, projectName: "First project" },
      { project: SECOND, projectName: "Second project" },
      { project: FIRST, projectName: "Shared name" },
      { project: SECOND, projectName: "Shared name" },
    ],
    projectCatalog: [],
  }) });
  const resolve = indexedProjectResolver(directory);
  const outcome = (run: () => string) => {
    try { return { project: run() }; }
    catch (error) {
      if (!(error instanceof ProjectNameRefusal)) throw error;
      return { code: error.details.code, candidates: error.details.candidates };
    }
  };
  for (const name of [FIRST, SECOND, "First project", " First-project ", "SECOND_PROJECT", "Shared name",
    "unknown name", ...Array.from({ length: 25 }, (_, i) => FIRST.slice(0, 12 + i))]) {
    expect(outcome(() => resolve(name)), name).toEqual(outcome(() => resolveNamedProject(name, directory)));
  }
  expect(resolve("First project")).toBe(FIRST);
  expect(outcome(() => resolve("repo-12345678"))).toMatchObject({ code: "ambiguous_project", candidates: [FIRST, SECOND] });
});
