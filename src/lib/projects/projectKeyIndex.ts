const store = globalThis as typeof globalThis & { __llvProjectKeySources?: Map<string, ReadonlySet<string>> };

function sources(): Map<string, ReadonlySet<string>> {
  return store.__llvProjectKeySources ??= new Map();
}

export function replaceProjectKeySource(owner: string, projects: Iterable<string>): void {
  sources().set(owner, new Set(projects));
}

export function projectKeyIndexSnapshot(): ReadonlySet<string> {
  const keys = new Set<string>();
  for (const projects of sources().values()) for (const project of projects) keys.add(project);
  return keys;
}
