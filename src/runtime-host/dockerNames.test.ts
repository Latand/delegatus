import { expect, test } from "bun:test";

import { viewerCandidateContainerName, viewerCandidateImageName, viewerComposeSnapshotName } from "./deploymentArtifacts";
import {
  DELEGATUS_DOCKER_NAMES,
  DOCKER_NAMES,
  isProductContainer,
  LEGACY_DOCKER_NAMES,
  RECOGNIZED_DOCKER_NAMES,
  runtimeHostServiceImageTag,
} from "./dockerNames";
import { runtimeHostSuccessorName } from "./hostSuccessor";
import { stagingImageName } from "./stagingContainer";

test("rename slice 3: this release still names everything the old way", () => {
  expect(DOCKER_NAMES).toBe(LEGACY_DOCKER_NAMES);
  expect(runtimeHostServiceImageTag()).toBe("agent-log-viewer:node22");
  expect(viewerCandidateContainerName("deployment")).toMatch(/^llv-deploy-[0-9a-f]{24}$/);
  expect(viewerCandidateImageName("a".repeat(40), "llv-deploy-x")).toMatch(/^agent-log-viewer:deploy-a{40}-[0-9a-f]{24}$/);
  expect(runtimeHostSuccessorName("a".repeat(40), "agent-log-viewer:x")).toMatch(/^llv-runtime-host-a{12}-[0-9a-f]{12}$/);
  expect(stagingImageName("a".repeat(40))).toBe("agent-log-viewer:staging-aaaaaaaaaaaa");
});

test("rename slice 3: both spellings are recognized, the one this release writes first", () => {
  expect(RECOGNIZED_DOCKER_NAMES).toEqual([LEGACY_DOCKER_NAMES, DELEGATUS_DOCKER_NAMES]);
  expect(runtimeHostSuccessorName("d".repeat(40), "delegatus:x", DELEGATUS_DOCKER_NAMES))
    .toMatch(/^delegatus-runtime-host-d{12}-[0-9a-f]{12}$/);
  for (const name of ["llv-deploy-abc", "/llv-runtime-host-abc-def", "delegatus-deploy-abc", "delegatus-runtime-host-abc-def"]) {
    expect(isProductContainer(name)).toBe(true);
  }
  for (const name of ["postgres", "llvm-builder", "delegatusx-runtime-host"]) {
    expect(isProductContainer(name)).toBe(false);
  }
});

test("rename slice 3: a compose snapshot is keyed by the container, so either spelling finds its own", () => {
  const legacy = viewerComposeSnapshotName(`${LEGACY_DOCKER_NAMES.viewerDeployPrefix}abc`);
  const renamed = viewerComposeSnapshotName(`${DELEGATUS_DOCKER_NAMES.viewerDeployPrefix}abc`);
  expect(legacy).toMatch(/^[0-9a-f]{24}\.json$/);
  expect(renamed).toMatch(/^[0-9a-f]{24}\.json$/);
  expect(legacy).not.toBe(renamed);
  expect(viewerComposeSnapshotName(`${DELEGATUS_DOCKER_NAMES.viewerDeployPrefix}abc`)).toBe(renamed);
});
