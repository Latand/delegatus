/**
 * Reads lucide-react's own name → module table (`dynamicIconImports.mjs`),
 * which the generator writes `lucideIconNames.ts` from and the drift test
 * compares it against (#2102). An entry whose name differs from the module it
 * loads is an alias: lucide keeps it for a renamed icon, and the icon's name
 * is the module's.
 */
export function parseLucideIconImports(source: string): { names: string[]; aliases: Map<string, string> } {
  const names = new Set<string>();
  const aliases = new Map<string, string>();
  for (const match of source.matchAll(/"([^"]+)":\s*\(\)\s*=>\s*import\('\.\/icons\/([^']+)\.mjs'\)/g)) {
    const [, key, module] = match as unknown as [string, string, string];
    names.add(module);
    if (key !== module) aliases.set(key, module);
  }
  return {
    names: [...names].sort(),
    aliases: new Map([...aliases].sort(([a], [b]) => a.localeCompare(b))),
  };
}
