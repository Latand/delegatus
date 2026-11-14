/** Native engine context retains media for continuation. Secondary projections
 * (journals, answer history and the transcript catalog) retain no pixels/refs. */
export function redactMediaText(text: string): string {
  return text.replace(/media_[0-9a-f]{32}/g, "[private media]")
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "[private image]");
}

export function redactMediaProjection<T>(value: T): T {
  const visit = (item: unknown, depth: number): unknown => {
    if (depth > 64) return "[omitted]";
    if (typeof item === "string") {
      // Codex and Claude also wrap tool results as JSON strings.
      if (/^\s*[\[{]/.test(item) && /"(?:image|relay_service_tools|relay_answer)"/.test(item)) {
        try { return JSON.stringify(visit(JSON.parse(item), depth + 1)); } catch { /* ordinary text */ }
      }
      return redactMediaText(item);
    }
    if (!item || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.map(child => visit(child, depth + 1));
    const record = item as Record<string, unknown>;
    if (record.type === "image" || record.type === "input_image" || record.type === "image_url")
      return { type: record.type, omitted: "private media" };
    const tool = record.tool ?? record.name ?? record.toolName;
    if (typeof tool === "string" && /(?:^|__)relay_(?:service_tools|answer)$/.test(tool)) {
      return Object.fromEntries(["type", "id", "name", "tool", "toolName", "server", "status", "is_error"]
        .filter(key => record[key] !== undefined).map(key => [key, visit(record[key], depth + 1)]));
    }
    return Object.fromEntries(Object.entries(record).map(([key, child]) => [key, visit(child, depth + 1)]));
  };
  return visit(value, 0) as T;
}
