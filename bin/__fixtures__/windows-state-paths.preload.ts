/* POSIX CI exercises the actual terminal entrypoint with Windows state paths.
 * Only filesystem addressing is translated; processes, custody and probes run
 * unchanged. Native Windows uses its real filesystem without this preload. */
import { mock } from "bun:test";
import fs from "node:fs";
import path from "node:path";

const nativeFs = fs;
const nativePath = path;
const prefix = "C:\\fixtures";
const root = process.env.LLV_TEST_WINDOWS_STATE_ROOT!;
const windowsPath = (value: unknown): value is string => typeof value === "string" && value.startsWith(prefix);
const physical = (value: unknown) => windowsPath(value) ? nativePath.join(root, ...value.slice(prefix.length).split("\\").filter(Boolean)) : value;
const mappedFs: Record<string, unknown> = { ...nativeFs };
for (const name of ["existsSync", "mkdirSync", "readFileSync", "writeFileSync", "rmSync", "openSync"] as const) {
  const original = nativeFs[name] as (...args: unknown[]) => unknown;
  mappedFs[name] = (file: unknown, ...args: unknown[]) => original(physical(file), ...args);
}
mappedFs.renameSync = (from: unknown, to: unknown) => nativeFs.renameSync(physical(from) as string, physical(to) as string);
mock.module("node:fs", () => ({ ...mappedFs, default: mappedFs }));

const mappedPath = { ...nativePath,
  basename: (value: string, suffix?: string) => (windowsPath(value) ? nativePath.win32 : nativePath).basename(value, suffix),
  dirname: (value: string) => (windowsPath(value) ? nativePath.win32 : nativePath).dirname(value),
  join: (...parts: string[]) => (windowsPath(parts[0]) ? nativePath.win32 : nativePath).join(...parts),
};
mock.module("node:path", () => ({ ...mappedPath, default: mappedPath }));
