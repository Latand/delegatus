/** Native engine context retains media for continuation. Secondary projections
 * (journals, answer history and the transcript catalog) retain no pixels/refs. */
export function redactMediaText(text: string): string {
  return text.replace(/media_[0-9a-f]{32}/g, "[private media]")
    .replace(/data:image\/[a-z0-9.+-]+;base64,[a-z0-9+/=]+/gi, "[private image]");
}

export function redactMediaProjection<T>(value: T): T {
  const visit = (item: unknown, depth: number, imageContext = false): unknown => {
    if (depth > 64) return "[omitted]";
    if (typeof item === "string") {
      // A string may contain several JSON values (or a code-mode wrapper).
      // Parsing one greedy span cannot establish that every image envelope was
      // inspected, so discard any image-bearing wrapper as a whole.
      if (/(?:image|input_image|image_url)/i.test(item) && /(?:base64|data\s*[:=]|"data"\s*:)/i.test(item)) {
        return "[private relay media omitted]";
      }
      if (imageContext && /^[A-Za-z0-9+/]{16,}={0,2}$/.test(item)) return "[private image]";
      // Tool output can be embedded after code-mode prefixes or inside another
      // JSON string. Parse the first complete JSON value wherever it appears.
      const start = item.search(/[\[{]/);
      if (start >= 0 && /(?:image|relay_service_tools|relay_answer)/i.test(item)) {
        const end = Math.max(item.lastIndexOf("}"), item.lastIndexOf("]"));
        if (end >= start) {
          try {
            const parsed = visit(JSON.parse(item.slice(start, end + 1)), depth + 1, imageContext);
            return `${item.slice(0, start)}${JSON.stringify(parsed)}${item.slice(end + 1)}`;
          } catch { /* ordinary text or a non-JSON wrapper */ }
        }
      }
      // If a media tool emitted an unparseable wrapper, discard its full text
      // rather than retaining an uninspected pixels field.
      if (/(?:image|input_image|image_url)/i.test(item) && /(?:base64|data)/i.test(item)) {
        return "[private relay media omitted]";
      }
      return redactMediaText(item);
    }
    if (!item || typeof item !== "object") return item;
    if (Array.isArray(item)) return item.map(child => visit(child, depth + 1, imageContext));
    const record = item as Record<string, unknown>;
    const imageNode = imageContext || record.type === "image" || record.type === "input_image" || record.type === "image_url"
      || (typeof (record.mimeType ?? record.mime_type) === "string" && String(record.mimeType ?? record.mime_type).startsWith("image/"));
    if (record.type === "image" || record.type === "input_image" || record.type === "image_url") {
      const safe = Object.fromEntries(Object.entries(record)
        .filter(([key]) => key !== "data")
        .map(([key, child]) => [key, visit(child, depth + 1)]));
      if (record.source && typeof record.source === "object" && !Array.isArray(record.source)) {
        const source = record.source as Record<string, unknown>;
        safe.source = Object.fromEntries(Object.entries(source)
          .filter(([key]) => key !== "data")
          .map(([key, child]) => [key, visit(child, depth + 2)]));
      }
      return safe;
    }
    const tool = record.tool ?? record.name ?? record.toolName;
    if (typeof tool === "string" && /(?:^|__)relay_(?:service_tools|answer)$/.test(tool)) {
      return Object.fromEntries(["type", "id", "name", "tool", "toolName", "server", "status", "is_error"]
        .filter(key => record[key] !== undefined).map(key => [key, visit(record[key], depth + 1)]));
    }
    return Object.fromEntries(Object.entries(record)
      .filter(([key]) => !(imageNode && key === "data"))
      .map(([key, child]) => [key, visit(child, depth + 1, key === "image")]));
  };
  return visit(value, 0) as T;
}
