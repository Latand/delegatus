import { afterEach, expect, test } from "bun:test";
import { cancelTierCut, forgetTierCutsForTests, switchConversationTier, tierCutState, type TierSwitchDependencies } from "./tierSwitch";
import type { RuntimeTierRequest } from "./engineHost";

const id = "conversation_tier_fixture";
function fixture() {
  let generation = { id: "generation-one", accountId: "acct-a", launchProfile: { model: "gpt-6.1-sol", effort: "medium", fast: false, serviceTier: "default" as string | null } };
  const effects: string[] = [];
  const writes: unknown[] = [];
  let beforeWrite = () => {};
  const host = {
    setTier: async (request: RuntimeTierRequest) => {
      request.authorizeDispatch?.();
      effects.push(request.serviceTier ?? "default");
      return { appliedTier: request.serviceTier, cut: "none" as const, echoed: true };
    },
    cancelArmedTierCut: () => true,
  };
  const dependencies: TierSwitchDependencies = {
    host: async () => host as never,
    registry: {
      conversation: () => ({ generations: [generation] }) as never,
      deliveryWriteOrBusy: async (_correlation: unknown, write: () => unknown) => { beforeWrite(); return write(); },
      updateConversationLaunchProfile: (_id: unknown, patch: object) => { writes.push(patch); generation.launchProfile = { ...generation.launchProfile, ...patch }; },
    } as never,
  };
  return { dependencies, host, effects, writes, generation: () => generation,
    replace: (patch: Partial<typeof generation>) => { generation = { ...generation, ...patch }; },
    beforeWrite: (callback: () => void) => { beforeWrite = callback; } };
}
afterEach(forgetTierCutsForTests);

test("a late withdrawal cannot replace a completed cut with a cancellation receipt", async () => {
  const f = fixture();
  let settle!: (state: "cut") => void;
  const settled = new Promise<"cut">(resolve => { settle = resolve; });
  const host = { ...f.host,
    setTier: async () => ({ appliedTier: "ultrafast", cut: "armed", settled }),
    cancelArmedTierCut: () => false,
  };
  const dependencies = { ...f.dependencies, host: async () => host as never };
  await switchConversationTier(id, "tier-late-cancel", "ultrafast", "boundary", dependencies);
  await cancelTierCut(id, "tier-late-cancel", dependencies);
  settle("cut");
  await new Promise<void>(resolve => setImmediate(resolve));
  expect(tierCutState("tier-late-cancel")).toBe("cut");
});

test("a no-cut return without a held host restores the persisted profile for the next resume", async () => {
  const f = fixture();
  f.replace({ launchProfile: { ...f.generation().launchProfile, serviceTier: "ultrafast" } });
  const result = await switchConversationTier(id, "tier-return", null, "none", { ...f.dependencies, host: async () => null });
  expect(result.cut).toBe("none");
  expect(f.generation().launchProfile.serviceTier).toBeNull();
  expect(f.effects).toEqual([]);
});

test("a missing host still refuses acceleration and an offline return rechecks generation after admission", async () => {
  const f = fixture();
  const dependencies = { ...f.dependencies, host: async () => null };
  await expect(switchConversationTier(id, "tier-raise", "ultrafast", "boundary", dependencies)).rejects.toThrow("cannot change");
  f.beforeWrite(() => f.replace({ id: "generation-two" }));
  await expect(switchConversationTier(id, "tier-return", null, "none", dependencies)).rejects.toThrow("generation changed");
  expect(f.writes).toEqual([]);
});

test("a tier switch records the applied tier while preserving a newer effort chosen during state admission", async () => {
  const f = fixture();
  f.beforeWrite(() => f.replace({ launchProfile: { ...f.generation().launchProfile, effort: "high" } }));
  await switchConversationTier(id, "tier-one", "ultrafast", "none", f.dependencies);
  expect(f.effects).toEqual(["ultrafast"]);
  expect(f.generation().launchProfile).toMatchObject({ effort: "high", serviceTier: "ultrafast" });
});

test("a runtime that changed after Turbo planned it is refused before native dispatch", async () => {
  const f = fixture();
  await expect(switchConversationTier(id, "tier-one", "ultrafast", "boundary", {
    ...f.dependencies, expected: { accountId: "acct-b", model: "gpt-6.1-sol" },
  })).rejects.toThrow("runtime changed");
  expect(f.effects).toEqual([]);
  expect(f.writes).toEqual([]);
});

test("a generation replaced while the host lookup waits cannot receive the old tier operation", async () => {
  const f = fixture();
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const work = switchConversationTier(id, "tier-one", "ultrafast", "boundary", {
    ...f.dependencies, host: async () => { enter(); await held; return f.host as never; },
  });
  await entered;
  f.replace({ id: "generation-two" });
  release();
  await expect(work).rejects.toThrow("runtime changed");
  expect(f.effects).toEqual([]);
});

test("a generation replaced during the profile write keeps its own profile", async () => {
  const f = fixture();
  f.beforeWrite(() => f.replace({ id: "generation-two" }));
  await expect(switchConversationTier(id, "tier-one", "ultrafast", "none", f.dependencies)).rejects.toThrow("generation changed");
  expect(f.writes).toEqual([]);
  expect(f.generation().launchProfile.serviceTier).toBe("default");
});
