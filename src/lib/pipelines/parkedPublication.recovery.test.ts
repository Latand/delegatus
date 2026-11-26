import path from "node:path";
import { isolatedParkedPublicationTest } from "./parkedPublication.fixture";

isolatedParkedPublicationTest(path.join(import.meta.dir, "parkedPublication.test.ts"), "recovery");
