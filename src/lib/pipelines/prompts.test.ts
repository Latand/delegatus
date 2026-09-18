import { expect, test } from "bun:test";

import { buildPipeline } from "./store";
import { renderStagePrompt } from "./prompts";
import type { PipelineStage } from "./types";

test("run prompt renders task, previous output, spec, access, verdict, and nesting contracts", () => {
  const stage: PipelineStage = {
    id: "build",
    kind: "run" as const,
    role: { roleId: "builder" },
    engine: "codex" as const,
    ["prompt"]: "Build {{task}} from {{prev.output}}",
    next: "review",
    effectiveRole: { roleId: "builder", engine: "codex", model: null, effort: "high", access: "read-write", promptScaffold: "Keep the implementation focused on {{task}}." },
  };
  const pipeline = buildPipeline({
    id: "12345678",
    task: "pipeline support",
    spec: "AC1: structured verdict",
    project: "viewer",
    repoDir: "/repo",
    stages: [stage, { ...stage, id: "review", next: null }],
    srcPath: null,
    srcConversationId: null,
    now: "now",
  });
  const prompt = renderStagePrompt(pipeline, stage, {
    roleId: "builder",
    engine: "codex",
    model: null,
    effort: "high",
    access: "read-write",
    promptScaffold: "Keep the implementation focused on {{task}}.",
  }, "the plan");
  expect(prompt).toContain("Build pipeline support from the plan");
  expect(prompt).toContain("AC1: structured verdict");
  expect(prompt).toContain("Access: read-write");
  expect(prompt).toContain('"status":"pass"');
  expect(prompt).toContain('"findings":[]');
  expect(prompt).toContain("REQUEST_CHANGES=fail");
  expect(prompt).toContain("Role preset: builder");
  expect(prompt).toContain("Keep the implementation focused on pipeline support.");
});

test("role-less prompts omit role identity and scaffolding", () => {
  const stage: PipelineStage = {
    id: "research",
    kind: "run",
    ["prompt"]: "Investigate {{task}}",
    next: "write",
    effectiveRole: { roleId: null, engine: "codex", model: "gpt-5.6-sol", effort: "medium", access: "read-write", promptScaffold: null },
  };
  const pipeline = buildPipeline({
    id: "12345678",
    task: "pipeline support",
    project: "viewer",
    repoDir: "/repo",
    stages: [stage, { ...stage, id: "write", next: null }],
    srcPath: null,
    srcConversationId: null,
    now: "now",
  });
  const prompt = renderStagePrompt(pipeline, stage, {
    roleId: null,
    engine: "codex",
    model: "gpt-5.6-sol",
    effort: "high",
    access: "read-write",
    promptScaffold: null,
  }, "");
  expect(prompt).toContain("Investigate pipeline support");
  expect(prompt).toContain("Pinned task:");
  expect(prompt).toContain('"status":"pass"');
  expect(prompt).not.toContain("Role preset:");
  expect(prompt).not.toContain("Role prompt scaffold:");
});

test("a prompt without {{prev.output}} still receives the relayed previous output (#1678)", () => {
  const stage: PipelineStage = {
    id: "verify",
    kind: "run",
    role: { roleId: "builder" },
    engine: "claude",
    ["prompt"]: "Verify the fact the previous stage reported for {{task}}.",
    next: null,
    effectiveRole: { roleId: "builder", engine: "claude", model: "haiku", effort: "low", access: "read-only", promptScaffold: "Builder guidance." },
  };
  const pipeline = buildPipeline({
    id: "12345678",
    task: "pipeline support",
    project: "viewer",
    repoDir: "/repo",
    stages: [{ ...stage, id: "observe", next: "verify" }, stage],
    srcPath: null,
    srcConversationId: null,
    now: "now",
  });
  const role = stage.effectiveRole;
  const relayed = renderStagePrompt(pipeline, stage, role, "name agent-log-viewer, version 1.1.0");
  const section = relayed.indexOf("Previous stage output");
  expect(section).toBeGreaterThan(relayed.indexOf("Verify the fact the previous stage reported for pipeline support."));
  expect(section).toBeLessThan(relayed.indexOf("Pinned task:"));
  expect(relayed).toContain("name agent-log-viewer, version 1.1.0");

  /* An entry stage, or one whose predecessor wrote nothing, gets no empty section. */
  expect(renderStagePrompt(pipeline, stage, role, "")).not.toContain("Previous stage output");
  expect(renderStagePrompt(pipeline, stage, role, "   \n")).not.toContain("Previous stage output");

  /* A prompt or scaffold that places the relay itself keeps sole control of where it lands. */
  const placed = renderStagePrompt(pipeline, { ...stage, ["prompt"]: "Relay:\n{{prev.output}}\nVerify {{task}}." }, role, "the observation");
  expect(placed).toContain("Relay:\nthe observation\nVerify pipeline support.");
  expect(placed).not.toContain("Previous stage output");
  const scaffolded = renderStagePrompt(pipeline, stage, { ...role, promptScaffold: "Context: {{prev.output}}" }, "the observation");
  expect(scaffolded).toContain("Context: the observation");
  expect(scaffolded).not.toContain("Previous stage output");
});
