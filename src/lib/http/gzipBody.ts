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
  let gzip: number | null = null;
  let wildcard: number | null = null;
  for (const part of header.split(",")) {
    const [coding, ...parameters] = part.trim().toLowerCase().split(";");
    const name = coding!.trim();
    if (name !== "gzip" && name !== "*") continue;
    const quality = parameters.map((parameter) => parameter.trim()).find((parameter) => parameter.startsWith("q="));
    const value = quality === undefined ? 1 : Number(quality.slice(2));
    const weight = Number.isFinite(value) ? value : 0;
    if (name === "gzip") gzip = Math.max(gzip ?? 0, weight);
    else wildcard = Math.max(wildcard ?? 0, weight);
  }
  /* An explicit gzip entry decides, whatever the wildcard says; `*` covers
     gzip only when gzip is not named at all. */
  return (gzip ?? wildcard ?? 0) > 0;
}

/** Compress on the zlib thread pool, so a large body never blocks the
    request thread while it compresses. */
export async function gzipBody(body: string): Promise<Uint8Array> {
  return new Uint8Array(await gzipAsync(body, { level: 6 }));
}
