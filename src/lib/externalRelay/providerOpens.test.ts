import { expect, test } from "bun:test";
import { checkProviderOpens, collectProviderOpen, type ProviderOpen } from "./providerOpens";
import { createPageReader } from "./pageReader";
const reader = createPageReader({ interfaces: () => ({}), env: {}, hostname: () => "installation.example",
  resolve: async host => [{ address: host === "installation.example" ? "192.0.2.9" : host === "loop.example" ? "127.0.0.1" : "8.8.8.8", family: 4 }], dial: (() => { throw new Error("provider gate must not dial"); }) as never });
const signal = new AbortController().signal;
test("public opens pass without a fetch; each redirect URL is checked", async () => {
  expect(await checkProviderOpens([{ urls: ["https://example.org", "https://example.org/final"] }], 1, { reader, signal })).toBeNull();
  for (const url of ["http://loop.example", `http://${[10, 0, 0, 1].join(".")}`, "https://installation.example", "file:///secret", "http://[fc00::1]"]) {
    const refusal = await checkProviderOpens([{ urls: ["https://example.org", url] }], 2, { reader, signal });
    expect(refusal).toMatchObject({ round: 2, tool: "web_search", status: "denied", code: "url_refused", refusal: { provider: true } });
  }
});
test("missing URLs, host overflow and malformed URLs fail closed", async () => {
  for (const opens of [[{ urls: [] }], [{ urls: Array.from({ length: 17 }, (_, i) => `https://host${i}.example`) }]])
    expect(await checkProviderOpens(opens, 1, { reader, signal })).toMatchObject({ refusal: { class: "unverifiable_open" } });
  expect(await checkProviderOpens([{ urls: ["malformed"] }], 1, { reader, signal })).toMatchObject({ status: "error", code: "invalid_url" });
});
test("collector has bounded evidence and retains a refusal on overflow", () => {
  const opens: ProviderOpen[] = [];
  for (let i = 0; i < 130; i++) collectProviderOpen(opens, { urls: ["https://example.org"] });
  expect(opens).toHaveLength(128); expect(opens.at(-1)?.urls).toEqual([]);
});

test("started placeholders reconcile only with their matching completed item", async () => {
  const opens: ProviderOpen[] = [];
  collectProviderOpen(opens, { urls: [], id: "search", pending: true });
  collectProviderOpen(opens, { urls: [], id: "other-search", search: true });
  expect(await checkProviderOpens(opens, 1, { reader, signal })).toMatchObject({ refusal: { class: "unverifiable_open" } });
  collectProviderOpen(opens, { urls: [], id: "search", search: true });
  expect(await checkProviderOpens(opens, 1, { reader, signal })).toBeNull();
  collectProviderOpen(opens, { urls: ["http://127.0.0.1"], id: "open" });
  collectProviderOpen(opens, { urls: [], id: "open", search: true });
  expect(await checkProviderOpens(opens, 1, { reader, signal })).toMatchObject({ refusal: { class: "loopback" } });
});
