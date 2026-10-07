/** `objectJson` with `members` appended as its last members. For text that
    `JSON.stringify` wrote and that holds none of those names, the result is
    byte for byte `JSON.stringify({ ...JSON.parse(objectJson), ...members })`.
    Null when the text is not one JSON object, so the caller takes the parsing
    path. */
export function withJsonMembers(objectJson: string, members: Record<string, unknown>): string | null {
  if (objectJson.charCodeAt(0) !== 123 || objectJson.charCodeAt(objectJson.length - 1) !== 125) return null;
  const appended = JSON.stringify(members);
  if (appended === "{}") return objectJson;
  return objectJson.length === 2 ? appended : `${objectJson.slice(0, -1)},${appended.slice(1)}`;
}
