import { expect, test } from "bun:test";

import { en } from "./en";
import { uk } from "./uk";

/* Issues #702 and #1301: every agent starts on a structured host, and a
   launch or a resume answers with no terminal target. Spawn copy names no
   transport. */
const TRANSPORT_FREE_SPAWN_KEYS = ["composer.placeholderSpawn", "composer.spawnAria", "composer.launchAgent", "composer.titleSpawnResumed", "composer.spawned", "composer.spawnedUnnamed"] as const;

test("spawn copy that cannot know the transport names none in either locale", () => {
  for (const key of TRANSPORT_FREE_SPAWN_KEYS) {
    for (const [locale, dictionary] of [["en", en], ["uk", uk]] as const) {
      const value = dictionary[key];
      expect(typeof value).toBe("string");
      expect(`${locale}:${key}:${value as string}`.toLowerCase()).not.toContain("tmux");
    }
  }
});

test("the composer's post-send line still names the target it was given", () => {
  /* Dropping the transport must not drop the target with it: a legacy pane send
     resolves one, and the operator reads it to find the pane. */
  for (const dictionary of [en, uk]) expect(dictionary["composer.spawned"]).toContain("{target}");
});
