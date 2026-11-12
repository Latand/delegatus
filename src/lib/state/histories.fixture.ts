/* Synthetic legacy files shaped like a busy installation's (#1870 slice 8):
   the counts and sizes match what one was measured to hold, and every value
   is invented. */

const T0 = 1_780_000_000;

function sequence(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state / 2 ** 32;
  };
}

function samples(count: number, end: number, random: () => number): { t: number; remaining: number }[] {
  return Array.from({ length: count }, (_, index) => ({
    t: end - (count - 1 - index) * 300,
    remaining: Math.round(random() * 1000) / 10,
  }));
}

/** 14 attributed series of 650 to 1,900 samples and 3 quarantined ones:
    about 0.7 MB compact, 1.4 MB as the store pretty-prints it. */
export function limitsHistoryFixture(end = T0): Record<string, unknown> {
  const random = sequence(7);
  const lengths = [1906, 1813, 1709, 1704, 1697, 1640, 1640, 1591, 1591, 1383, 1020, 925, 653, 653];
  const series: Record<string, unknown> = {};
  lengths.forEach((length, index) => {
    const engine = index < 4 ? "claude" : "codex";
    series[`${engine}|account-${Math.floor(index / 2)}|${index % 2 ? "weekly" : "session"}`] = samples(length, end, random);
  });
  return {
    version: 1,
    codexAttributionVersion: 1,
    unattributedCodexSeries: {
      "codex|legacy-a|weekly": samples(1110, end - 9 * 86_400, random),
      "codex|legacy-b|session": samples(51, end - 9 * 86_400, random),
      "codex|legacy-b|weekly": samples(51, end - 9 * 86_400, random),
    },
    since: new Date((end - 30 * 86_400) * 1000).toISOString(),
    series,
  };
}

function transcriptPath(index: number): string {
  const hex = (index * 2_654_435_761 >>> 0).toString(16).padStart(8, "0");
  return `/sessions/fixture-project-${index % 97}/subagents/${hex}-${hex.slice(0, 4)}-4${hex.slice(1, 4)}-8${hex.slice(2, 5)}-${hex}${hex.slice(0, 4)}.jsonl`;
}

/** 14,887 owner-authored transcripts and 4,976 clean stamps, 325 of them on
    authored paths: about 3 MB pretty-printed. */
export function reaperStateFixture(): Record<string, unknown> {
  const userAuthoredPaths: Record<string, true> = {};
  const scannedAt: Record<string, number> = {};
  for (let index = 0; index < 14_887; index += 1) userAuthoredPaths[transcriptPath(index)] = true;
  for (let index = 0; index < 4_976; index += 1) {
    scannedAt[transcriptPath(index < 325 ? index : 20_000 + index)] = T0 - index * 37.25;
  }
  return { version: 1, firstObservedAt: {}, userAuthoredPaths, scannedAt };
}

/** 544 transcript edges and 544 conversation edges, no live panes. */
export function handoffLineageFixture(children = 544): Record<string, unknown> {
  const childEdges: Record<string, string> = {};
  const conversations: Record<string, string> = {};
  for (let index = 0; index < children; index += 1) {
    childEdges[transcriptPath(40_000 + index)] = transcriptPath(60_000 + index);
    if (index < 544) conversations[`conversation_child-${index}`] = `conversation_parent-${index}`;
  }
  return { panes: {}, children: childEdges, conversationChildren: conversations };
}

export { transcriptPath as fixtureTranscriptPath, T0 as FIXTURE_NOW };
