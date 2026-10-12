import { expect, test } from "bun:test";
import fs from "node:fs";
test("macOS release installation follows successful npm publication and checks out its exact revision", () => {
  const body = fs.readFileSync(new URL("../.github/workflows/macos-newcomer.yml", import.meta.url), "utf8");
  expect(body).toContain('workflows: ["Publish to npm"]');
  expect(body).toContain("github.event.workflow_run.conclusion == 'success'");
  expect(body).toContain("github.event.workflow_run.head_sha");
  expect(body).not.toContain('tags: ["v*"]');
});
