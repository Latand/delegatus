import path from "node:path";

/** Mediate the compiler module actually opened by a descendant, before its
 * bytes reach the interpreter. No install search, source rewrite or caller
 * runtime option is involved. Nested runners already inside this supervisor
 * retain it; a systemd handoff establishes its own supervisor. */
export function withCompilerEntry(command: string[]) {
  if (process.platform !== "linux") return;
  return {
    command: [Bun.which("python3") ?? "/usr/bin/python3", "-I", path.join(import.meta.dir, "check-worker-entry.py"), ...command],
    release: () => {},
  };
}
