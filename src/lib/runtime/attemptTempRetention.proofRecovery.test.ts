import { afterEach } from "bun:test";
import { cleanupPressureFixtures } from "./attemptTempPressure.testSupport";
import { protectedTailTests } from "./attemptTempRetention.proofCases.fixture";

afterEach(cleanupPressureFixtures);
protectedTailTests(8);
