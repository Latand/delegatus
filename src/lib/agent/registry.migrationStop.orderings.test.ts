import { declareOrderingTests, declareSweepStateTest } from "./registry.migrationStop.orderings.fixture";

/* The table of orderings under a clock that runs forward, every way a row's
   sweeps can be left (registry.migrationStop.orderings.fixture.ts). */
declareSweepStateTest();
declareOrderingTests(["running forward"], [0, 1, 2, 3, 4, 5, 6]);
