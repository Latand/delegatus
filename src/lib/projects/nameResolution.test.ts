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

test("every spelling the resolver indexes names the source keys that contributed it", async () => {
  const fs = await import("node:fs"), os = await import("node:os"), path = await import("node:path");
  const { recordProjectRemote } = await import("./aliases");
  const { projectAliasStore } = await import("./persistence");
  const { createManualProject } = await import("./curation");
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "name-sources-"));
  const previous = process.env.LLV_STATE_DIR;
  process.env.LLV_STATE_DIR = path.join(root, "state");
  try {
    const OWN = "repo-" + "1".repeat(32), CATALOG = "repo-" + "3".repeat(32), FILE = "repo-" + "4".repeat(32), REMOTE = "repo-" + "5".repeat(32);
    const manualRoot = path.join(root, "ManualWidgetsRoot"); fs.mkdirSync(manualRoot);
    const created = createManualProject("Manual Widgets", manualRoot);
    if (!created.ok) throw new Error(created.code);
    const MANUAL = created.entry.project;
    projectAliasStore.mutate(path.join(process.env.LLV_STATE_DIR!, "project-aliases.json"), current => ({
      next: { ...current, aliases: { ...current.aliases, "legacy-board": OWN, [MANUAL]: "middle-alias", "middle-alias": OWN,
        [CATALOG]: OWN, [FILE]: OWN, [REMOTE]: OWN } }, result: undefined }));
    recordProjectRemote({ project: REMOTE, canonicalRemote: "github.com/example/remote-widgets" });
    const directory = namedProjectDirectory({ includeActiveSeats: false,
      authorizedSeats: () => [{ project: OWN }], callerProject: () => OWN,
      lastCompletedCatalog: () => ({ files: [{ project: FILE, projectName: "Retained Widgets" }],
        projectCatalog: [{ project: CATALOG, displayName: "Catalog Widgets", projectRoot: path.join(root, "CatalogRepo") }] }) }, ["dir-" + "6".repeat(32)]);
    // Each source kind resolves to the selected project and names its own key.
    for (const [spelling, source] of [["Manual Widgets", MANUAL], [manualRoot, MANUAL], ["ManualWidgetsRoot", MANUAL],
      ["MANUALWIDGETSROOT", MANUAL], ["Catalog Widgets", CATALOG], ["CatalogRepo", CATALOG], [path.join(root, "CatalogRepo"), CATALOG],
      ["Retained Widgets", FILE], ["legacy_board", "legacy-board"], ["remote-widgets", REMOTE], [CATALOG.slice(0, 12), CATALOG]] as const) {
      expect(resolveNamedProject(spelling, directory), spelling).toBe(OWN);
      expect(directory.sources(spelling), spelling).toContain(source);
    }
    // No vocabulary is indexed without the keys behind it: whatever a spelling
    // selects is reachable from the sources it reports.
    for (const index of [directory.names, directory.identities, directory.encodedDirectories]) {
      for (const [spelling, projects] of index) {
        const reached = new Set(directory.sources(spelling).map(directory.canonical));
        for (const project of projects) expect(reached.has(project), spelling).toBe(true);
      }
    }
    expect(directory.sources("   ")).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.LLV_STATE_DIR; else process.env.LLV_STATE_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
