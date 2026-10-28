import { expect, test } from "bun:test";

import {
  COORDINATOR_VOICE_PERSONA,
  spokenVoicePersona,
  voiceSessionPersona,
} from "./voicePersona";

test("the built-in persona stands when no override file exists", () => {
  const persona = spokenVoicePersona("coordinator", () => { throw new Error("ENOENT"); });
  expect(persona).toBe(COORDINATOR_VOICE_PERSONA);
});

test("an operator override replaces the built-in persona wholesale", () => {
  /* A new thread resolves the current override wholesale; an established
     thread keeps the developer item it already persisted. */
  const persona = spokenVoicePersona("coordinator", () => "  You are the coordinator. Keep it short.  ");
  expect(persona).toBe("You are the coordinator. Keep it short.");
  expect(persona).not.toBe(COORDINATOR_VOICE_PERSONA);
});

test("an empty or whitespace override falls back instead of muting the persona", () => {
  expect(spokenVoicePersona("coordinator", () => "   \n  ")).toBe(COORDINATOR_VOICE_PERSONA);
});

test("one variant produces one stable session persona", () => {
  /* Stable so the voice panel and the tests can name the persona a live call is
     running on, and so a reconnect on the same variant is recognisably the same
     persona rather than a new one. */
  const persona = voiceSessionPersona("coordinator", () => "  Resolved call persona. \n");
  expect(voiceSessionPersona("coordinator", () => "  Resolved call persona. \n")).toEqual(persona);
  expect(persona.prompt).toBe("Resolved call persona.");
  expect(persona.variant).toBe("coordinator");
  expect(voiceSessionPersona("modality").personaId).not.toBe(persona.personaId);
});

test("a session persona writes nothing that could outlive its call", () => {
  /* The property the whole repair rests on. `thread/inject_items` appends to an
     append-only transcript, so a persona written that way is permanent and each
     variant accumulated its own copy; these three strings are parameters of one
     `thread/realtime/start` and are gone when the call is. */
  const persona = voiceSessionPersona("modality");
  expect(Object.keys(persona).sort()).toEqual([
    "endInstructions", "personaId", "prompt", "startInstructions", "variant",
  ]);
  for (const value of Object.values(persona)) expect(typeof value).toBe("string");
});
