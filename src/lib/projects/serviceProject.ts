const LEGATUS_PREFIX = "legatus:";

export function isLegatusProject(project: string): boolean {
  return project.startsWith(LEGATUS_PREFIX);
}

export function legatusProjectKey(installId: string): string {
  return LEGATUS_PREFIX + installId;
}
