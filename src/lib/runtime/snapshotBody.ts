/** `objectJson`, the UTF-8 bytes of one JSON object, with `members` appended
    as its last members. For bytes that `JSON.stringify` wrote and that hold
    none of those names, the result is byte for byte
    `JSON.stringify({ ...JSON.parse(objectJson), ...members })`. Null when the
    bytes are not one JSON object, so the caller takes the parsing path. */
export function withJsonMembers(objectJson: Uint8Array, members: Record<string, unknown>): Uint8Array | null {
  if (objectJson[0] !== 123 || objectJson[objectJson.length - 1] !== 125) return null;
  const appended = JSON.stringify(members);
  if (appended === "{}") return objectJson;
  if (objectJson.length === 2) return Buffer.from(appended);
  // One copy of the object, without a decode: everything before its closing brace, then the members.
  return Buffer.concat([objectJson.subarray(0, objectJson.length - 1), Buffer.from(`,${appended.slice(1)}`)]);
}
