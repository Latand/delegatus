export type SiteEvent = {
  event: "copy_prompt" | "copy_legacy" | "demo_start" | "fullscreen_open";
  lang: "en" | "uk";
  agent?: "claude" | "codex";
};

export function isSiteEvent(value: unknown): value is SiteEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as Record<string, unknown>;
  if (body.lang !== "en" && body.lang !== "uk") return false;
  if (body.event === "copy_prompt") {
    return (body.agent === "claude" || body.agent === "codex") &&
      Object.keys(body).length === 3;
  }
  return ["copy_legacy", "demo_start", "fullscreen_open"].includes(body.event as string) &&
    Object.keys(body).length === 2;
}

export type InstallPing = { id: string; v: string; os: string; arch: string; kind: "packaged" | "checkout" | "docker" };
const semver = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/;
export function isInstallPing(value: unknown): value is InstallPing {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const b = value as Record<string, unknown>;
  return Object.keys(b).length === 5 &&
    typeof b.id === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(b.id) &&
    typeof b.v === "string" && b.v.length <= 128 && semver.test(b.v) &&
    ["aix", "darwin", "freebsd", "linux", "openbsd", "sunos", "win32", "android", "haiku", "netbsd", "cygwin"].includes(b.os as string) &&
    ["arm", "arm64", "ia32", "loong64", "mips", "mipsel", "ppc", "ppc64", "riscv64", "s390", "s390x", "x64"].includes(b.arch as string) &&
    ["packaged", "checkout", "docker"].includes(b.kind as string);
}

export const DAY = 86_400_000;
export const utcDay = (time: number) => new Date(time).toISOString().slice(0, 10);
export const countryCode = (value: unknown) => typeof value === "string" && /^[A-Z]{2}$/.test(value) ? value : "";
