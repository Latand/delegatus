import type { ProjectActionResult } from "./rights";

/*
 * The browser's side of a project's presentation settings
 * (src/lib/projects/presentation.ts, PUT /api/projects/settings): a display
 * name, or null for the folder's name again, and the archive switch.
 * Activity restoration uses POST with identity only; the server verifies activity.
 */

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export async function writeProjectPresentation(
  project: string,
  patch: { name: string | null } | { archived: boolean } | { restoreOnActivity: true },
  fetcher: Fetcher = fetch,
): Promise<ProjectActionResult> {
  let response: Response;
  try {
    response = await fetcher("/api/projects/settings", {
      method: "restoreOnActivity" in patch ? "POST" : "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify("restoreOnActivity" in patch ? { project } : { project, ...patch }),
    });
  } catch {
    return { ok: false, code: "NETWORK" };
  }
  if (response.ok) return { ok: true };
  let code: string | null = null;
  try {
    const body = await response.json() as { code?: unknown; error?: unknown };
    code = typeof body.code === "string" ? body.code : typeof body.error === "string" ? body.error : null;
  } catch {
    /* an empty refusal keeps its status only */
  }
  return { ok: false, code };
}

/** The name the operator chose, or null while the folder names the project. Throws when the read fails. */
export async function readProjectName(project: string, signal?: AbortSignal, fetcher: Fetcher = fetch): Promise<string | null> {
  const response = await fetcher(`/api/projects/settings?project=${encodeURIComponent(project)}`, { cache: "no-store", signal });
  if (!response.ok) throw new Error(`project settings read failed: ${response.status}`);
  const body = await response.json() as { name?: unknown };
  if (body.name === undefined) throw new Error("project settings answer carries no name");
  return typeof body.name === "string" ? body.name : null;
}
