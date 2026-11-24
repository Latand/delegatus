import path from "node:path";

/** True only for the one canonical gate invocation that prepares a receipt. */
export function isPublicationPreparationInvocation(command: string, args: readonly string[], cwd: string): boolean {
  if ((command !== "bun" && command !== "bun-container")
    || args.length !== 3 || args[1] !== "pre-push" || args[2] !== "--publication-prepare") return false;
  const canonicalEntry = path.resolve(cwd, "scripts/local-gate.ts");
  return args[0] === "scripts/local-gate.ts"
    || (path.isAbsolute(args[0] ?? "") && path.resolve(args[0]!) === canonicalEntry);
}
