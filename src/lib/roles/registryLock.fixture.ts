import { loadRoleOverrides, saveRoleOverrides, withRoleRegistryLock } from "./store";

/* A second process that writes the role registry while holding its lock: the
   parent sees "locked", and this process changes the builder row before it lets
   go. Used by rolePresets.test.ts to interleave two writers. */
const HOLD_MS = 700;

withRoleRegistryLock(() => {
  console.log("locked");
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, HOLD_MS);
  const stored = loadRoleOverrides();
  saveRoleOverrides({ ...stored.overrides, builder: { config: { engine: "claude", model: "opus", effort: "high" } } });
});
console.log("released");
