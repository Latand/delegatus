import path from "node:path";
import { projectAliasStore, projectCurationStore, projectRemoteStore, worktreeMapStore } from "@/lib/projects/persistence";
import { sessionTitleStore } from "@/lib/session/titleStore";
import type { LegacyDocumentStore } from "./legacyDocumentStore";
export const slice6Cases = [
  ["project-aliases.json", projectAliasStore, { schemaVersion: 1, aliases: { old: "fixture" }, displayNames: { fixture: "Fixture" } }],
  ["project-curation.json", projectCurationStore, { schemaVersion: 1, crowned: ["fixture"], manualProjects: [{ project: "fixture", displayName: "Fixture", root: "/fixture", createdAt: 1 }] }],
  ["project-remotes.json", projectRemoteStore, { schemaVersion: 1, remotes: { fixture: "github.com/example/fixture" } }],
  ["worktree-map.json", worktreeMapStore, { "/fixture-checkout": { repo: "/fixture", worktree: "fixture-lane" } }],
  ["session-titles.json", sessionTitleStore, { version: 1, titles: [{ key: "conversation:fixture", title: "Fixture", revision: 7, updatedAt: "2026-10-01T00:00:00Z" }] }],
] as unknown as [string, LegacyDocumentStore<unknown>, unknown][];
if (import.meta.main) {
  console.log(JSON.stringify(slice6Cases.map(([name, store]) => {
    const file = path.join(process.argv[2]!, name);
    return { name, state: store.importLegacy(file).state, value: store.read(file) };
  })));
}
