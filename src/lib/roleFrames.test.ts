import { expect, test } from "bun:test";
import vm from "node:vm";

import { ROLE_IDS } from "@/lib/roles/types";

import {
  conversationFrameRole,
  DEFAULT_ROLE_FRAME,
  FRAME_ROLES,
  parseRoleFrameChoice,
  resolveRoleFrameVariant,
  ROLE_FRAME_BOOT_SCRIPT,
  ROLE_FRAME_STORAGE_KEY,
  ROLE_FRAME_VARIANTS,
} from "./roleFrames";

test("every registry role has a frame, and anything else is neutral", () => {
  expect(FRAME_ROLES).toEqual([...ROLE_IDS, "neutral"]);
  for (const roleId of ROLE_IDS) expect(conversationFrameRole({ stage: { kind: "run", role: { roleId } } })).toBe(roleId);
  expect(conversationFrameRole({ stage: { kind: "run", role: { roleId: "critic" } } })).toBe("neutral");
  expect(conversationFrameRole({})).toBe("neutral");
  expect(conversationFrameRole({ file: { durableLineage: { role: "helper", memberships: [] } } })).toBe("neutral");
});

test("the seat designation outranks every other source", () => {
  expect(conversationFrameRole({ seat: true, stage: { kind: "run", role: { roleId: "builder" } } })).toBe("orchestrator");
  expect(conversationFrameRole({ file: { seat: true } })).toBe("orchestrator");
  expect(conversationFrameRole({ file: { durableLineage: { role: null, memberships: [{ kind: "orchestrator", role: "seat" }] } } })).toBe("orchestrator");
});

test("a review loop's two sides wear their own frames inside one review-loop stage", () => {
  const stage = { kind: "review-loop", role: { roleId: "reviewer" } };
  expect(conversationFrameRole({ stage, file: { flow: { flowRole: "implementer" } } })).toBe("builder");
  expect(conversationFrameRole({ stage, file: { flow: { flowRole: "reviewer" } } })).toBe("reviewer");
  expect(conversationFrameRole({ stage, file: { durableLineage: { role: null, memberships: [{ kind: "flow", role: "implementer" }] } } })).toBe("builder");
  /* A role-less review-loop stage with no membership in hand is a review. */
  expect(conversationFrameRole({ stage: { kind: "review-loop" } })).toBe("reviewer");
});

test("outside a pipeline, the durable spawn lineage names the role", () => {
  expect(conversationFrameRole({ file: { durableLineage: { role: "architect", memberships: [] } } })).toBe("architect");
  expect(conversationFrameRole({ file: { durableLineage: { role: "worker", memberships: [] } } })).toBe("builder");
  expect(conversationFrameRole({ file: { durableLineage: { role: null, memberships: [{ kind: "pipeline", role: "verifier" }] } } })).toBe("verifier");
});

test("the variant comes from the query, then the stored choice, then the default", () => {
  expect(parseRoleFrameChoice(" Rail ")).toBe("rail");
  expect(parseRoleFrameChoice("none")).toBe("off");
  expect(parseRoleFrameChoice("sparkle")).toBeNull();
  expect(resolveRoleFrameVariant("?roleFrame=halo", "rail")).toEqual({ choice: "halo", remember: "halo" });
  expect(resolveRoleFrameVariant("?roleFrame=off", "rail")).toEqual({ choice: "off", remember: "off" });
  expect(resolveRoleFrameVariant("?roleFrame=nope", "bracket")).toEqual({ choice: "bracket", remember: null });
  expect(resolveRoleFrameVariant("", null)).toEqual({ choice: DEFAULT_ROLE_FRAME, remember: null });
});

/** Runs the inline boot script the way the page does, against a fake document and storage. */
function boot(search: string, stored: string | null) {
  const store = new Map<string, string>(stored === null ? [] : [[ROLE_FRAME_STORAGE_KEY, stored]]);
  const attributes = new Map<string, string>();
  vm.runInNewContext(ROLE_FRAME_BOOT_SCRIPT, {
    location: { search },
    URLSearchParams,
    localStorage: { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => void store.set(key, value) },
    document: { documentElement: { setAttribute: (name: string, value: string) => void attributes.set(name, value) } },
  });
  return { attribute: attributes.get("data-role-frame") ?? "off", stored: store.get(ROLE_FRAME_STORAGE_KEY) ?? null };
}

test("the boot script resolves exactly as resolveRoleFrameVariant does", () => {
  const searches = ["", "?roleFrame=off", "?roleFrame=none", "?roleFrame=nope", "?x=1&roleFrame=RIBBON", ...ROLE_FRAME_VARIANTS.map((variant) => `?roleFrame=${variant}`)];
  const storedValues = [null, "off", "junk", ...ROLE_FRAME_VARIANTS];
  for (const search of searches) {
    for (const stored of storedValues) {
      const expected = resolveRoleFrameVariant(search, stored);
      const actual = boot(search, stored);
      expect({ search, stored, attribute: actual.attribute }).toEqual({ search, stored, attribute: expected.choice });
      expect(actual.stored).toBe(expected.remember ?? stored);
    }
  }
});
