import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import { hostname, networkInterfaces } from "node:os";

export type PageRefusal = { class: string; host: string; hop: number; provider?: true };
export class PageReadError extends Error {
  constructor(public readonly code: string, public readonly refusal?: PageRefusal) {
    super(refusal ? refusalMessage(refusal.class) : `Page read failed: ${code}.`);
  }
}
export function refusalMessage(kind: string): string {
  const reason: Record<string, string> = {
    scheme: "only http and https pages are read",
    credentials: "addresses with a user name or password are not read",
    port: "only the scheme's default port is read",
    installation_host: "the address belongs to the installation running this assistant",
    installation_address: "the address belongs to the installation running this assistant",
    installation_unverifiable: "the installation's public addresses could not be verified",
    loopback: "the address points at this machine", unspecified: "the address points at this machine",
    link_local: "the address is private or local-network", private: "the address is private or local-network",
    unique_local: "the address is private or local-network", reserved: "the address is outside the public internet",
    unverifiable_open: "the search tool opened a page whose address could not be checked; use read_page",
  };
  return `Refused: ${reason[kind] ?? "the address could not be checked"}.`;
}
export type PagePolicyRuntime = {
  resolve?: (host: string) => Promise<readonly { address: string; family: number }[]>;
  interfaces?: typeof networkInterfaces;
  env?: Readonly<Record<string, string | undefined>>;
  hostname?: () => string;
};
export type CheckedPageUrl = { url: URL; addresses: readonly { address: string; family: number }[] };
const blocks: [string, BlockList][] = [];
for (const [kind, ranges] of Object.entries({
  loopback: ["127.0.0.0/8", "::1/128"], unspecified: ["0.0.0.0/8", "::/128"],
  link_local: ["169.254.0.0/16", "fe80::/10"],
  private: [[10, 0, 0, 0, 8], [172, 16, 0, 0, 12], [192, 168, 0, 0, 16], [100, 64, 0, 0, 10]]
    .map(([a, b, c, d, prefix]) => `${[a, b, c, d].join(".")}/${prefix}`),
  unique_local: ["fc00::/7"],
  reserved: ["192.0.0.0/24", "192.0.2.0/24", "198.18.0.0/15", "198.51.100.0/24", "203.0.113.0/24", "224.0.0.0/4", "240.0.0.0/4", "2001::/32", "2001:db8::/32", "2002::/16"],
})) {
  const block = new BlockList();
  for (const range of ranges) {
    const [address, prefix] = range.split("/");
    block.addSubnet(address!, Number(prefix), isIP(address!) === 6 ? "ipv6" : "ipv4");
  }
  blocks.push([kind, block]);
}
const globalV6 = new BlockList(); globalV6.addSubnet("2000::", 3, "ipv6");
const mappedV4 = new BlockList(); mappedV4.addSubnet("::ffff:0:0", 96, "ipv6");
const normalizeHost = (host: string) => host.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
function installationHosts(runtime: PagePolicyRuntime): Set<string> {
  const env = runtime.env ?? process.env;
  const names = [env.LLV_PUBLIC_HOST, env.LLV_PUBLIC_ORIGIN, env.LLV_TS_HOST, env.HOSTNAME, (runtime.hostname ?? hostname)()];
  return new Set(names.flatMap(value => {
    if (!value) return [];
    try { return [normalizeHost(new URL(value.includes("://") ? value : `http://${value}`).hostname)]; }
    catch { return [normalizeHost(value)]; }
  }));
}
function installationNames(runtime: PagePolicyRuntime): string[] {
  const env = runtime.env ?? process.env;
  const values = [env.LLV_PUBLIC_HOST, env.LLV_PUBLIC_ORIGIN, env.LLV_TS_HOST, env.HOSTNAME, (runtime.hostname ?? hostname)()];
  return [...new Set(values.flatMap(value => {
    if (!value) return [];
    try { return [normalizeHost(new URL(value.includes("://") ? value : `http://${value}`).hostname)]; }
    catch { return []; }
  }))];
}
function installationAddresses(runtime: PagePolicyRuntime, names: readonly string[]): BlockList {
  const own = new BlockList();
  for (const host of names) {
    const family = isIP(host);
    if (family) own.addAddress(host, family === 6 ? "ipv6" : "ipv4");
  }
  return own;
}
function addressClass(address: string, interfaces: ReturnType<typeof networkInterfaces>, ownInstallation: BlockList): string | null {
  const family = isIP(address) === 6 ? "ipv6" : "ipv4";
  if (!isIP(address)) return "reserved";
  const own = new BlockList();
  for (const rows of Object.values(interfaces)) for (const row of rows ?? []) {
    const bare = row.address.split("%")[0]!;
    if (isIP(bare)) own.addAddress(bare, isIP(bare) === 6 ? "ipv6" : "ipv4");
  }
  if (own.check(address, family) || ownInstallation.check(address, family)) return "installation_address";
  for (const [kind, block] of blocks) if (block.check(address, family)) return kind;
  if (family === "ipv6" && !mappedV4.check(address, family) && !globalV6.check(address, family)) return "reserved";
  return null;
}
/** Bound DNS even when a resolver does not support cancellation. */
export async function pageWithin<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    return await Promise.race([work(), new Promise<never>((_, reject) => {
      abort = () => reject(new PageReadError("timeout"));
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    })]);
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}
export async function checkPageUrl(input: string, runtime: PagePolicyRuntime = {}, options: { signal?: AbortSignal; hop?: number } = {}): Promise<CheckedPageUrl> {
  if (options.signal?.aborted) throw new PageReadError("timeout");
  let url: URL;
  try { if (input.length > 2048) throw new Error(); url = new URL(input); }
  catch { throw new PageReadError("invalid_url"); }
  const host = normalizeHost(url.hostname), hop = options.hop ?? 0;
  const refuse = (kind: string): never => { throw new PageReadError("url_refused", { class: kind, host, hop }); };
  if (!["http:", "https:"].includes(url.protocol)) refuse("scheme");
  if (url.username || url.password) refuse("credentials");
  if (host === "localhost" || host.endsWith(".localhost")) refuse("loopback");
  if (installationHosts(runtime).has(host)) refuse("installation_host");
  const interfaces = (runtime.interfaces ?? networkInterfaces)();
  const ownHosts = installationNames(runtime);
  const ownInstallation = installationAddresses(runtime, ownHosts);
  if (isIP(host)) { const kind = addressClass(host, interfaces, ownInstallation); if (kind) refuse(kind); }
  if (url.port) refuse("port");
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000);
  let addresses: CheckedPageUrl["addresses"];
  const resolved = new Map<string, CheckedPageUrl["addresses"]>();
  const resolve = async (name: string) => {
    if (!resolved.has(name)) {
      const answers = await pageWithin(() => runtime.resolve ? runtime.resolve(name) : lookup(name, { all: true, verbatim: true }), signal);
      if (!answers.length || answers.length > 32 || answers.some(answer => !isIP(answer.address) || answer.family !== isIP(answer.address)))
        throw new PageReadError("unreachable");
      resolved.set(name, answers);
    }
    return resolved.get(name)!;
  };
  try {
    for (const ownHost of ownHosts) if (!isIP(ownHost)) {
      try {
        for (const { address, family } of await resolve(ownHost))
          ownInstallation.addAddress(address, family === 6 ? "ipv6" : "ipv4");
      }
      catch {
        if (signal.aborted) throw new PageReadError("timeout");
        refuse("installation_unverifiable");
      }
    }
    addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await resolve(host);
  }
  catch (error) { throw signal.aborted ? new PageReadError("timeout") : error instanceof PageReadError ? error : new PageReadError("unreachable"); }
  if (!addresses.length) throw new PageReadError("unreachable");
  if (installationHosts(runtime).has(host)) refuse("installation_host");
  const resolvedInterfaces = isIP(host) ? interfaces : (runtime.interfaces ?? networkInterfaces)();
  for (const { address } of addresses) { const kind = addressClass(address, resolvedInterfaces, ownInstallation); if (kind) refuse(kind); }
  url.hash = "";
  return { url, addresses };
}
