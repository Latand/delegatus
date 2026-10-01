import { expect, test } from "bun:test";
import { checkApiBase } from "./client";
import { KNOWN_RELAYS, knownRelay, knownRelayInfo, ownOriginIcon } from "./knownRelays";

const celestia = knownRelay("celestia")!;

test("the built-in list names Celestia by its https origin", () => {
  expect(KNOWN_RELAYS.map((relay) => relay.id)).toEqual(["celestia"]);
  expect(celestia).toEqual({ id: "celestia", name: "Celestia", origin: "https://chatmoderator.botfather.dev" });
  expect(knownRelay("missing")).toBeNull();
});

test("the icon is kept only as a file on the relay's own origin, read over the origin's scheme", () => {
  // The descriptor Celestia publishes before it has moved its API to https.
  expect(ownOriginIcon(celestia.origin, "http://chatmoderator.botfather.dev/.well-known/celestia-connect.jpg"))
    .toBe("https://chatmoderator.botfather.dev/.well-known/celestia-connect.jpg");
  expect(ownOriginIcon(celestia.origin, "/icon.png")).toBe("https://chatmoderator.botfather.dev/icon.png");
  expect(ownOriginIcon(celestia.origin, "https://tracker.example/pixel.png")).toBeNull();
  expect(ownOriginIcon(celestia.origin, "https://chatmoderator.botfather.dev:8443/icon.png")).toBeNull();
  const withUserinfo = new URL(`${celestia.origin}/icon.png`);
  withUserinfo.username = "someone";
  expect(ownOriginIcon(celestia.origin, withUserinfo.href)).toBeNull();
  expect(ownOriginIcon(celestia.origin, undefined)).toBeNull();
  expect(ownOriginIcon(celestia.origin, "http://[bad")).toBeNull();
});

test("a descriptor that cannot be read leaves the entry as listed; one that can adds its description and icon", () => {
  expect(knownRelayInfo(celestia, null)).toEqual({ ...celestia, description: null, iconUrl: null });
  expect(knownRelayInfo(celestia, { description: "Answers on your machine.", icon_url: "/icon.jpg" })).toEqual({
    ...celestia,
    description: "Answers on your machine.",
    iconUrl: "https://chatmoderator.botfather.dev/icon.jpg",
  });
});

test("an https service that advertises its own host over http is not available securely yet; pointing elsewhere stays cross_origin", () => {
  const origin = celestia.origin;
  expect(() => checkApiBase(origin, "http://chatmoderator.botfather.dev/api/relay/v1")).toThrow(expect.objectContaining({ code: "http_public" }));
  expect(() => checkApiBase(origin, "https://other.example/v1")).toThrow(expect.objectContaining({ code: "cross_origin" }));
  expect(() => checkApiBase(origin, "http://other.example/v1")).toThrow(expect.objectContaining({ code: "cross_origin" }));
  expect(() => checkApiBase(origin, "https://chatmoderator.botfather.dev/api/relay")).toThrow(expect.objectContaining({ code: "invalid_api_path" }));
  expect(() => checkApiBase(origin, "https://chatmoderator.botfather.dev/api/relay/v1")).not.toThrow();
});
