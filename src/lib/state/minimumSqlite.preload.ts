/**
 * `bun test --preload` this file to run any suite on the minimum SQLite
 * (minimumSqlite.fixture.ts): every `bun:sqlite` import, require and
 * `process.getBuiltinModule("bun:sqlite")` in the process gets the FFI module.
 * Child processes a suite starts keep Bun's own SQLite.
 */
import { mock } from "bun:test";
import { minimumSqliteLibrary, minimumSqliteModule } from "./minimumSqlite.fixture";

const sqlite = minimumSqliteModule(minimumSqliteLibrary());
mock.module("bun:sqlite", () => sqlite);
const builtin = process.getBuiltinModule.bind(process);
process.getBuiltinModule = ((id: string) => id === "bun:sqlite" ? sqlite : builtin(id)) as typeof process.getBuiltinModule;
