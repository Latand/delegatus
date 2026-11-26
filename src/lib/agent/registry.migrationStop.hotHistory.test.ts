import { test } from "bun:test";
import { measureMigrationStop } from "./registry.migrationStop.incident.fixture";

test("a stale intent is stopped at incident size with bounded hot sweep writes", () =>
  measureMigrationStop("hot"), 600_000);
