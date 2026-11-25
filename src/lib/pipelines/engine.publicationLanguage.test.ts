import { expect, test, harness, createPipelineFromRequest, BUILD_ONLY, loadPipelines } from "./engine.fixture";

test("create_pipeline stores an explicit publication title independently of the board", async () => {
  const h = harness();
  const created = await createPipelineFromRequest({ task: "Виправити публікацію", prTitle: "Fix GitHub publication text",
    spec: "Keep public prose in English", repoDir: "/repo", stages: BUILD_ONLY as never,
    publication: "internal", autoStart: false, src: "/codex/creator.jsonl" }, h.ports);
  expect(created.error).toBeUndefined();
  expect(created.pipeline?.prTitle).toBe("Fix GitHub publication text");
  expect(loadPipelines().find(p => p.id === created.pipeline!.id)!.task).toBe("Виправити публікацію");
});

test.each(["", "two\nlines", "x".repeat(121), 42])("create_pipeline rejects a malformed public title (%j)", async prTitle => {
  const h = harness();
  const created = await createPipelineFromRequest({ task: "Fix publication", prTitle: prTitle as string,
    spec: "Keep public prose in English", repoDir: "/repo", stages: BUILD_ONLY as never,
    publication: "internal", autoStart: false, src: "/codex/creator.jsonl" }, h.ports);
  expect(created.pipeline).toBeUndefined();
  expect(created.violations).toContainEqual(expect.objectContaining({ field: "prTitle" }));
});
