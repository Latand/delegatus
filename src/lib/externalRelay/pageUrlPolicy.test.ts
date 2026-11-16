import { expect, test } from "bun:test";
import { checkPageUrl, PageReadError, type PagePolicyRuntime } from "./pageUrlPolicy";
const runtime: PagePolicyRuntime = { interfaces: () => ({}), env: {}, hostname: () => "installation.example", resolve: async () => [{ address: "8.8.8.8", family: 4 }] };
const cases = [
  ["file:///document", "scheme"], ["gopher://example.org", "scheme"],
  ["https://" + ["user", "password"].join(":") + "@example.org", "credentials"],
  ["http://localhost", "loopback"], ["http://sub.localhost.", "loopback"],
  ["https://installation.example.", "installation_host"], ["https://example.org:8898", "port"],
  ...["127.1", "2130706433", "0x7f.1", "[::1]", "[::ffff:127.0.0.1]"].map(host => [`http://${host}`, "loopback"]),
  ...["0.0.0.0", "[::]"].map(host => [`http://${host}`, "unspecified"]),
  ...["169.254.169.254", "[fe80::1]"].map(host => [`http://${host}`, "link_local"]),
  ...[[10, 0, 0, 1].join("."), [172, 16, 0, 1].join("."), [192, 168, 0, 1].join("."), "100.64.0.1", `[::ffff:${[10, 0, 0, 1].join(".")}]`].map(host => [`http://${host}`, "private"]),
  ["http://[fd7a::1]", "unique_local"],
  ...["192.0.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "[64:ff9b::1]", "[ff00::1]", "[2001::1]", "[2001:db8::1]", "[2002::1]"].map(host => [`http://${host}`, "reserved"]),
];
for (const [url, kind] of cases) test(`refuses ${kind}: ${url}`, async () => {
  let resolves = 0;
  const error = await checkPageUrl(url!, { ...runtime, resolve: async host => { resolves++; return runtime.resolve!(host); } }).catch(error => error);
  expect(error).toBeInstanceOf(PageReadError);
  expect(error.refusal.class).toBe(kind); expect(resolves).toBe(0);
});
for (const variable of ["LLV_PUBLIC_HOST", "LLV_PUBLIC_ORIGIN", "LLV_TS_HOST", "HOSTNAME"]) test(`installation name from ${variable}`, async () => {
  await expect(checkPageUrl("https://self.example./signed?value=hidden", { ...runtime, env: { [variable]: variable === "LLV_PUBLIC_ORIGIN" ? "https://self.example" : "self.example" } })).rejects.toMatchObject({ refusal: { class: "installation_host", host: "self.example", hop: 0 } });
});
test("own interface addresses include mapped literals", async () => {
  const interfaces = () => ({ eth0: [{ address: "8.8.8.8" }] }) as unknown as ReturnType<NonNullable<PagePolicyRuntime["interfaces"]>>;
  for (const url of ["https://8.8.8.8", "https://[::ffff:8.8.8.8]"])
    await expect(checkPageUrl(url, { ...runtime, interfaces })).rejects.toMatchObject({ refusal: { class: "installation_address" } });
});
test("all DNS answers are checked, including mixed and loopback answers", async () => {
  for (const address of ["127.0.0.1", [10, 0, 0, 1].join("."), "fc00::1", "169.254.0.1"])
    await expect(checkPageUrl("https://example.org", { ...runtime, resolve: async () => [{ address: "8.8.8.8", family: 4 }, { address, family: address.includes(":") ? 6 : 4 }] })).rejects.toMatchObject({ code: "url_refused" });
  const checked = await checkPageUrl("https://example.org/page#fragment", { ...runtime, resolve: async () => [{ address: "8.8.8.8", family: 4 }, { address: "2606:4700:4700::1111", family: 6 }] });
  expect(checked.addresses).toHaveLength(2); expect(checked.url.hash).toBe("");
});
test("bad input, absent answers, failed DNS and cancellation are bounded errors", async () => {
  for (const input of ["bad", "x".repeat(2049)]) await expect(checkPageUrl(input, runtime)).rejects.toMatchObject({ code: "invalid_url" });
  await expect(checkPageUrl("https://example.org", { ...runtime, resolve: async () => [] })).rejects.toMatchObject({ code: "unreachable" });
  await expect(checkPageUrl("https://example.org", { ...runtime, resolve: async () => { throw new Error("private resolver detail"); } })).rejects.toMatchObject({ code: "unreachable" });
  await expect(checkPageUrl("https://example.org", { ...runtime, resolve: () => new Promise(() => {}) }, { signal: AbortSignal.timeout(10) })).rejects.toMatchObject({ code: "timeout" });
});
