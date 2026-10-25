import { expect, test } from "bun:test";

import { executeRealtimeControl } from "./realtimeControl";
import {
  COORDINATOR_VOICE_PERSONA,
  MODALITY_VOICE_PERSONA,
  resetVoicePersonaOverrideWarningForTest,
  VOICE_PERSONA_FILE,
  spokenVoicePersona,
  voiceSessionPersona,
} from "./voicePersona";
import { voicePersonaVariantFor } from "./voicePersonaMandate";

/**
 * Voice is a MODALITY, not a role (the #1615 regression).
 *
 * The operator enabled voice on the conversation holding their project's
 * orchestrator seat. The call start injected the voice-coordinator persona as a
 * durable `developer` item into that same thread, and the seat read its own new
 * instructions: relay everything to "the manager", touch no board tool. It relayed
 * with `bridge_directive`, which resolves the recipient from the designation record
 * — itself — so the instruction came straight back, and the seat declined the work
 * it was already holding.
 *
 * The retained tests cover variant selection, identity, overrides and live-call
 * controls.
 */

/** A conversation carrying no root marker: an ordinary session the operator
    toggled voice on. This is the incumbent case, and the common one. */
const INCUMBENT = {
  id: "conversation_incumbent",
  updatedAt: "2026-09-10T00:00:00.000Z",
  generations: [{ path: "/transcripts/incumbent.jsonl", launchProfile: { role: null } }],
};

/** A session deliberately launched as the root voice coordinator — the flow the
    coordinator persona was written for, and the one that must keep working. */
const EXPLICIT_COORDINATOR = {
  id: "conversation_root",
  updatedAt: "2026-09-10T00:00:00.000Z",
  generations: [{ path: "/transcripts/root.jsonl", launchProfile: { role: "root" } }],
};

/* ------------------------------------------------------------------ *
 * 1. Which persona a conversation is given.
 * ------------------------------------------------------------------ */

test("toggling voice on an incumbent resolves the modality persona, not the coordinator role", () => {
  expect(voicePersonaVariantFor(INCUMBENT.id, {
    conversation: INCUMBENT,
    configuredRootId: null,
  })).toBe("modality");
});

test("a session launched as root keeps the coordinator persona", () => {
  expect(voicePersonaVariantFor(EXPLICIT_COORDINATOR.id, {
    conversation: EXPLICIT_COORDINATOR,
    configuredRootId: null,
  })).toBe("coordinator");
});

test("the configured root conversation is a coordinator even before its role is stamped", () => {
  expect(voicePersonaVariantFor(INCUMBENT.id, {
    conversation: INCUMBENT,
    configuredRootId: INCUMBENT.id,
  })).toBe("coordinator");
});

test("an unresolvable conversation fails safe to the modality persona", () => {
  /* FAILS CLOSED TOWARD THE EXISTING ROLE. An unknown conversation is far more
     likely to be an incumbent the registry could not name than the one root
     session, and guessing "coordinator" is what overwrites a live role. */
  expect(voicePersonaVariantFor("conversation_unknown", {
    conversation: null,
    configuredRootId: null,
  })).toBe("modality");
});

test("spokenVoicePersona resolves the variant it is asked for", () => {
  const nothingOnDisk = () => { throw new Error("ENOENT"); };
  expect(spokenVoicePersona("coordinator", nothingOnDisk)).toBe(COORDINATOR_VOICE_PERSONA);
  expect(spokenVoicePersona("modality", nothingOnDisk)).toBe(MODALITY_VOICE_PERSONA);
});

test("an ignored override is reported once, so the operator can find out why", () => {
  /* Finding 4 of the #1615 review: the documented customization point silently
     became a no-op for every non-root call. It still does not apply — a
     coordinator-shaped wholesale override is what caused this defect — but it no
     longer does so without saying anything. */
  resetVoicePersonaOverrideWarningForTest();
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (...args: unknown[]) => { warnings.push(args.join(" ")); };
  try {
    expect(spokenVoicePersona("modality", () => "An operator's own persona.")).toBe(MODALITY_VOICE_PERSONA);
    expect(spokenVoicePersona("modality", () => "An operator's own persona.")).toBe(MODALITY_VOICE_PERSONA);
    /* Once per process: this resolves on every call start. */
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(VOICE_PERSONA_FILE);

    /* And nothing at all when there is no override to ignore. */
    resetVoicePersonaOverrideWarningForTest();
    warnings.length = 0;
    expect(spokenVoicePersona("modality", () => { throw new Error("ENOENT"); })).toBe(MODALITY_VOICE_PERSONA);
    expect(spokenVoicePersona("modality", () => "   \n ")).toBe(MODALITY_VOICE_PERSONA);
    expect(warnings).toEqual([]);
  } finally {
    console.warn = warn;
    resetVoicePersonaOverrideWarningForTest();
  }
});

test("an operator persona override applies to the coordinator only", () => {
  /* The override file is a wholesale replacement whose text is coordinator-shaped
     by construction. Applying it to an incumbent would reintroduce this very
     defect through the operator's own file, so the modality variant is built-in. */
  const override = () => "You are the voice coordinator. Relay everything.";
  expect(spokenVoicePersona("coordinator", override)).toBe("You are the voice coordinator. Relay everything.");
  expect(spokenVoicePersona("modality", override)).toBe(MODALITY_VOICE_PERSONA);
});

/* ------------------------------------------------------------------ *
 * 4. Identity: which persona a live call is running on.
 * ------------------------------------------------------------------ */

test("each variant owns a distinct persona identity", () => {
  const coordinator = voiceSessionPersona("coordinator");
  const modality = voiceSessionPersona("modality");
  expect(modality.personaId).not.toBe(coordinator.personaId);
  for (const persona of [coordinator, modality]) {
    expect(persona.personaId).toMatch(/^voice_persona_[a-f0-9]{46}$/);
  }
});

test("the persona identity follows the text, so an override is visible as a different call", () => {
  /* The id is evidence of WHICH persona a live call is running on. An override
     that changed the spoken instructions while reporting the built-in identity
     would make the voice panel and every regression assertion agree about a
     persona the call is not using. */
  const builtIn = voiceSessionPersona("coordinator", () => { throw new Error("ENOENT"); });
  const overridden = voiceSessionPersona("coordinator", () => "An operator's own persona.");
  expect(overridden.personaId).not.toBe(builtIn.personaId);
  expect(overridden.prompt).toBe("An operator's own persona.");
});

test("a session persona carries the spoken prompt and the backing pair, and nothing thread-durable", () => {
  /* The whole repair, as a shape: three session-scoped strings. Before this,
     the persona was a `thread/inject_items` write that reached the backing model
     permanently and the spoken model never. */
  const persona = voiceSessionPersona("modality", () => { throw new Error("ENOENT"); });
  expect(persona.prompt).toBe(MODALITY_VOICE_PERSONA);
  expect(Object.keys(persona).sort()).toEqual([
    "endInstructions", "personaId", "prompt", "startInstructions", "variant",
  ]);
});

/* ------------------------------------------------------------------ *
 * 5. On, off, and back on again.
 * ------------------------------------------------------------------ */

/** A host that records the persona variant every start was asked for. */
function recordingHost(variant: "coordinator" | "modality") {
  const starts: unknown[] = [];
  let live: string | null = null;
  return {
    starts,
    host: {
      async startRealtimeWebRtc(sdp: string, persona?: unknown) {
        starts.push(persona);
        live = "live-1";
        const { variant: resolved, personaId } = voiceSessionPersona(variant);
        return { sdp: "v=0\r\nanswer", realtimeSessionId: live, persona: { variant: resolved, personaId } };
      },
      async appendRealtimeSpeech() {},
      async stopRealtime() { live = null; },
      currentRealtimeSessionId() { return live; },
    },
  };
}

test("voice on, off and reconnect never promote an incumbent to coordinator", async () => {
  const { starts, host } = recordingHost("modality");
  const operator = { operator: true, personaVariant: "modality" as const };

  for (const _pass of [1, 2, 3]) {
    const started = await executeRealtimeControl(
      { action: "start", conversationId: "conversation_incumbent", sdp: "v=0\r\noffer\r\n" },
      () => host,
      operator,
    );
    expect(started.status).toBe(200);
    const stopped = await executeRealtimeControl(
      { action: "stop", conversationId: "conversation_incumbent" },
      () => host,
      operator,
    );
    expect(stopped.status).toBe(200);
  }

  /* Every reconnect, not merely the first: a variant resolved once and cached on
     the host would demote on the reconnect after a seat rotation. */
  expect(starts).toEqual(["modality", "modality", "modality"]);
});

test("an explicit coordinator session still starts as a coordinator", async () => {
  const { starts, host } = recordingHost("coordinator");
  const started = await executeRealtimeControl(
    { action: "start", conversationId: "conversation_root", sdp: "v=0\r\noffer\r\n" },
    () => host,
    { operator: true, personaVariant: "coordinator" },
  );
  expect(started.status).toBe(200);
  expect(starts).toEqual(["coordinator"]);
});

test("a start that asks no persona question gets the modality persona", async () => {
  /* An unasked question resolves to the answer that changes nothing about the
     conversation's role — the same fail-safe direction as the resolver above. */
  const { starts, host } = recordingHost("modality");
  const started = await executeRealtimeControl(
    { action: "start", conversationId: "conversation_incumbent", sdp: "v=0\r\noffer\r\n" },
    () => host,
    { operator: true },
  );
  expect(started.status).toBe(200);
  expect(starts).toEqual(["modality"]);
});
