import { declareOrderingTests } from "./registry.migrationStop.orderings.fixture";

// Keep every forward-clock ordering within the gate's per-file deadline.
declareOrderingTests(["running forward"], "odd");
