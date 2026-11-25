import { test } from "bun:test";
import { measureMigrationStop } from "./registry.migrationStop.incident.fixture";

test("a stale intent is stopped at incident size with bounded archived sweep writes", () =>
  measureMigrationStop("archived"), 600_000);
