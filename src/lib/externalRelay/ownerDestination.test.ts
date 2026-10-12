import { expect, test } from "bun:test";
import { selectOwnerDestination } from "./ownerDestination";
import { createTelegramPublisher } from "./telegramPublication";
import { startTestRelay } from "./testRelay";
import { destinationRelay, destinationTarget } from "./ownerDestination.fixture";

test("one enabled target uses the confirmed Telegram owner and several targets preserve store order with owner tier first", () => {
  const one = destinationRelay();
  expect(selectOwnerDestination([one])).toMatchObject({ relay: one, targetId: "first", chatId: "41" });
  const many = destinationRelay([destinationTarget("ordinary"), destinationTarget("owner-first", true), destinationTarget("owner-second", true)]);
  expect(selectOwnerDestination([many]).targetId).toBe("owner-first");
  many.targets[1]!.enabled = false;
  expect(selectOwnerDestination([many]).targetId).toBe("owner-second");
  many.targets[2]!.answered_by = "service";
  expect(selectOwnerDestination([many]).targetId).toBe("ordinary");
  const second = { ...destinationRelay([destinationTarget("second-pairing", true)]), id: "second" };
  expect(selectOwnerDestination([one, second]).targetId).toBe("second-pairing");
  expect(selectOwnerDestination([many, one]).targetId).toBe("ordinary");
});

test("missing pairing, missing enabled target and paused pairing stay off without a fallback destination", () => {
  expect(selectOwnerDestination([])).toEqual({ reason: "no_relay" });
  expect(selectOwnerDestination([{ ...destinationRelay(), origin: "https://other.example" }])).toEqual({ reason: "no_relay" });
  expect(selectOwnerDestination([destinationRelay([])])).toEqual({ reason: "no_target" });
  expect(selectOwnerDestination([destinationRelay([{ ...destinationTarget("disabled"), enabled: false }])])).toEqual({ reason: "no_target" });
  expect(selectOwnerDestination([{ ...destinationRelay(), paused: true }])).toEqual({ reason: "paused" });
  expect(selectOwnerDestination([destinationRelay([
    { ...destinationTarget("unconfigured"), engine: null }, destinationTarget("configured")])])).toEqual({ reason: "not_configured" });
  expect(selectOwnerDestination([destinationRelay([{ ...destinationTarget("missing-model"), model: null }])])).toEqual({ reason: "not_configured" });
  for (const owner of [{ namespace: "internal", id: "41" }, { namespace: "telegram", id: "owner" }, { namespace: "telegram", id: "-41" }])
    expect(selectOwnerDestination([{ ...destinationRelay(), owner: { ...destinationRelay().owner, ...owner } }])).toEqual({ reason: "invalid_owner" });
});

test("production publisher selection follows the first target and stops after pause, removal or bot replacement", async () => {
  const urls: string[] = [];
  const server = await startTestRelay(request => { urls.push(request.url!); return { body: { message_key: "m_fixture", replayed: false } }; });
  let relays = [{ ...destinationRelay([destinationTarget("first"), destinationTarget("second")]), api_base: `${server.origin}/v1` }];
  let bot = "123";
  const publisher = createTelegramPublisher(() => relays, () => bot);
  const receipt = { botId: bot, chatId: "41", messageId: 17, date: 1791724800, topicId: null, text: "Review" };
  try {
    expect(await publisher(receipt)).toBe("published");
    expect(urls).toEqual(["/v1/targets/first/messages"]);
    relays[0]!.paused = true;
    expect(await publisher(receipt)).toBe("skipped");
    relays[0]!.paused = false; relays[0]!.targets[0]!.engine = null;
    expect(await publisher(receipt)).toBe("skipped");
    relays[0]!.targets = [];
    expect(await publisher(receipt)).toBe("skipped");
    relays = [{ ...destinationRelay(), api_base: `${server.origin}/v1` }]; bot = "456";
    expect(await publisher(receipt)).toBe("skipped");
    relays = [];
    expect(await publisher(receipt)).toBe("skipped");
    expect(urls).toHaveLength(1);
  } finally { await server.close(); }
});
