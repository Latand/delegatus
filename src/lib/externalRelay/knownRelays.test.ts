import { expect, test } from "bun:test";
import { checkApiBase } from "./client";
import { KNOWN_RELAYS, knownRelay, knownRelayInfo, ownOriginIcon, verifyUrlAllowed } from "./knownRelays";

const celestia = knownRelay("celestia")!;
const CELESTIA_ORIGIN = "https://chatmoderator.botfather.dev";
/** The same host over plain http, built from the one listed origin. */
const celestiaHttp = (path: string): string => `${CELESTIA_ORIGIN.replace(/^https:/, "http:")}${path}`;
const celestiaPort = (port: number, path: string): string => `${CELESTIA_ORIGIN}:${port}${path}`;

test("the built-in list names Celestia by its https origin", () => {
  expect(KNOWN_RELAYS.map((relay) => relay.id)).toEqual(["celestia"]);
  expect(celestia).toEqual({ id: "celestia", name: "Celestia", origin: CELESTIA_ORIGIN, verifyHosts: ["t.me"] });
  expect(knownRelay("missing")).toBeNull();
});

test("the icon is kept only as a file on the relay's own origin, read over the origin's scheme", () => {
  // The descriptor Celestia publishes before it has moved its API to https.
  expect(ownOriginIcon(celestia.origin, celestiaHttp("/.well-known/celestia-connect.jpg")))
    .toBe(`${CELESTIA_ORIGIN}/.well-known/celestia-connect.jpg`);
  expect(ownOriginIcon(celestia.origin, "/icon.png")).toBe(`${CELESTIA_ORIGIN}/icon.png`);
  expect(ownOriginIcon(celestia.origin, "https://tracker.example/pixel.png")).toBeNull();
  expect(ownOriginIcon(celestia.origin, celestiaPort(8443, "/icon.png"))).toBeNull();
  const withUserinfo = new URL(`${celestia.origin}/icon.png`);
  withUserinfo.username = "someone";
  expect(ownOriginIcon(celestia.origin, withUserinfo.href)).toBeNull();
  expect(ownOriginIcon(celestia.origin, undefined)).toBeNull();
  expect(ownOriginIcon(celestia.origin, "http://[bad")).toBeNull();
});

test("a descriptor that cannot be read leaves the entry as listed; one that can adds its description and icon", () => {
  expect(knownRelayInfo(celestia, null)).toEqual({ ...celestia, description: null, iconUrl: null });
  expect(knownRelayInfo(celestia, { description: "Test", icon_url: null })).toEqual({ ...celestia, description: "Test", iconUrl: null });
  expect(knownRelayInfo(celestia, { description: "Answers on your machine.", icon_url: "/icon.jpg" })).toEqual({
    ...celestia,
    description: "Answers on your machine.",
    iconUrl: `${CELESTIA_ORIGIN}/icon.jpg`,
  });
});

test("an https service that advertises its own host over http is not available securely yet; pointing elsewhere stays cross_origin", () => {
  const origin = celestia.origin;
  expect(() => checkApiBase(origin, celestiaHttp("/api/relay/v1"))).toThrow(expect.objectContaining({ code: "http_public" }));
  expect(() => checkApiBase(origin, "https://other.example/v1")).toThrow(expect.objectContaining({ code: "cross_origin" }));
  expect(() => checkApiBase(origin, "http://other.example/v1")).toThrow(expect.objectContaining({ code: "cross_origin" }));
  expect(() => checkApiBase(origin, `${origin}/api/relay`)).toThrow(expect.objectContaining({ code: "invalid_api_path" }));
  expect(() => checkApiBase(origin, `${origin}/api/relay/v1`)).not.toThrow();
});

test("a verify link opens on its own only as https on the relay's origin or a host its list entry names", () => {
  const { origin, verifyHosts } = celestia;
  expect(verifyUrlAllowed(origin, verifyHosts, "https://t.me/celestia_bot?start=pair-ABCD")).toBe(true);
  expect(verifyUrlAllowed(origin, verifyHosts, `${origin}/pair?c=ABCD`)).toBe(true);
  expect(verifyUrlAllowed(origin, verifyHosts, celestiaHttp("/pair"))).toBe(false);
  expect(verifyUrlAllowed(origin, verifyHosts, "http://t.me/celestia_bot")).toBe(false);
  expect(verifyUrlAllowed(origin, verifyHosts, "https://elsewhere.example/pair")).toBe(false);
  expect(verifyUrlAllowed(origin, verifyHosts, "https://t.me.elsewhere.example/pair")).toBe(false);
  const verifyWithUserinfo = new URL("https://t.me/pair");
  verifyWithUserinfo.username = "someone";
  expect(verifyUrlAllowed(origin, verifyHosts, verifyWithUserinfo.href)).toBe(false);
  expect(verifyUrlAllowed(origin, verifyHosts, "https://t.me:8443/pair")).toBe(false);
  expect(verifyUrlAllowed(origin, verifyHosts, "javascript:alert(1)")).toBe(false);
  expect(verifyUrlAllowed(origin, verifyHosts, null)).toBe(false);
  // A relay that is not listed has only its own origin.
  expect(verifyUrlAllowed("https://relay.example", undefined, "https://relay.example/pair")).toBe(true);
  expect(verifyUrlAllowed("https://relay.example", undefined, "https://t.me/celestia_bot")).toBe(false);
});
