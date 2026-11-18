/** Keep the evolving service refusal wire shape at this boundary. */
export function answeredElsewhereResponse(status: number, body: unknown, targetId: string): boolean {
  if (status !== 409 || !body || typeof body !== "object" || Array.isArray(body)) return false;
  const record = body as Record<string, unknown>;
  const target = record.target && typeof record.target === "object" && !Array.isArray(record.target)
    ? record.target as Record<string, unknown> : record;
  if ([record.target_id, target.target_id].some(id => id !== undefined && id !== targetId)) return false;
  const error = record.error;
  return error === "answered_elsewhere" ||
    (error !== null && typeof error === "object" && !Array.isArray(error) && (error as Record<string, unknown>).code === "answered_elsewhere") ||
    target.answered_elsewhere === true;
}
