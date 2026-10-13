import { expect, test } from "bun:test";

import { ROLE_DEFAULTS } from "./defaults";
import { defaultRoleParameterValues } from "./parameters";

test("orchestrator drafts offer no launch-only worker limit", () => {
  const orchestrator = ROLE_DEFAULTS.find((role) => role.id === "orchestrator");
  if (!orchestrator) throw new Error("expected orchestrator role");

  expect(defaultRoleParameterValues(orchestrator)).not.toHaveProperty("maxWorkers");
});

test("unrelated integer draft parameters retain their minimum-based default", () => {
  const reviewer = ROLE_DEFAULTS.find((role) => role.id === "reviewer");
  if (!reviewer) throw new Error("expected reviewer role");

  expect(defaultRoleParameterValues(reviewer)).toMatchObject({ parallelN: 1 });
});
