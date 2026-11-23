import { prepareLockedDependencies } from "../src/lib/pipelines/lockedDependencies";

// Also runs after a merge, before the stage can interpret compiler diagnostics.
try {
  await prepareLockedDependencies(process.cwd());
} catch (error) {
  console.error(error instanceof Error ? error.message : "stage environment: dependency preparation failed");
  process.exitCode = 1;
}
