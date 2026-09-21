import { promisify } from "node:util";
import { gzip } from "node:zlib";

const gzipAsync = promisify(gzip);

/**
 * Whether the caller accepts a gzip body. The release path serves route
 * handler JSON as it was written, so megabyte board reads crossed the network
 * uncompressed even when the browser asked for gzip (#1994).
 */
export function acceptsGzip(request: Request): boolean {
  const header = request.headers.get("accept-encoding");
  if (!header) return false;
  return header.split(",").some((part) => {
    const [coding, ...parameters] = part.trim().toLowerCase().split(";");
    if (coding.trim() !== "gzip" && coding.trim() !== "*") return false;
    const quality = parameters.map((parameter) => parameter.trim()).find((parameter) => parameter.startsWith("q="));
    return quality === undefined || Number(quality.slice(2)) > 0;
  });
}

/** Compress on the zlib thread pool, so a large body never blocks the
    request thread while it compresses. */
export async function gzipBody(body: string): Promise<Uint8Array> {
  return new Uint8Array(await gzipAsync(body, { level: 6 }));
}
