import { declareOrderingTests } from "./registry.migrationStop.orderings.fixture";

/* The table of orderings under a clock frozen for the whole sequence and under
   one set back before every step (registry.migrationStop.orderings.fixture.ts). */
declareOrderingTests(["frozen", "set back before every step"]);
