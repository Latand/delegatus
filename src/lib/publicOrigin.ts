/** An operator-selected public HTTPS origin. Request headers cannot configure
 * it. Like LLV_PUBLIC_HOST, it is admitted only with the access key enabled. */
export function configuredPublicOrigin(): URL | null {
  const value = process.env.LLV_PUBLIC_ORIGIN;
  if (!process.env.LLV_TOKEN || !value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash
      || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z](?:[a-z0-9-]*[a-z0-9])?$/i.test(url.hostname)
      || url.hostname.endsWith(".localhost")) return null;
    return url;
  } catch {
    return null;
  }
}

/** Host selects only the configured authority, including its port. Forwarded
 * headers never select an origin or establish proxy / loopback authority. */
export function publicOriginForRequest(request: { headers: Headers }): URL | null {
  const origin = configuredPublicOrigin();
  return origin && request.headers.get("host")?.toLowerCase() === origin.host ? origin : null;
}
