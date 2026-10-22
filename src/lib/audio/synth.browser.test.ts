import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { chromium, type Browser, type Page } from "playwright-core";

import { ACTIVE_PALETTE, CALIBRATED_GAIN, EVENT_SOUNDS, type EventSoundId, type Loudness, type PaletteId } from "./synth";

/*
 * The render check of the sound map (docs/design/sound-redesign.md §6.3):
 * every event sound rendered by the real engine, in Chromium's Web Audio,
 * through the whole product graph (buses, limiter, the compressor's own
 * makeup taken back out, the 150 ms settle), at the default cue volume 0.4,
 * and measured (EBU R 128 momentary maximum, sample peak). Each must land
 * within 1 dB of the design's palette-2 table.
 *
 *   LLV_AUDIO_RENDER_TEST=1 CHROME_BIN=<chromium> bun test src/lib/audio/synth.browser.test.ts
 */

const enabled = process.env.LLV_AUDIO_RENDER_TEST === "1";
const browserTest = enabled ? test : test.skip;
const LAUNCH = { headless: true, args: ["--no-sandbox", "--autoplay-policy=no-user-gesture-required"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) };

/** §6.3, «Measured at the default 0.4, both palettes», the palette 2 column. */
const PALETTE_2_TABLE: Record<EventSoundId, Loudness> = {
  "your-move": { momentaryMax: -22.0, peakDb: -11.6 },
  fault: { momentaryMax: -24.0, peakDb: -14.4 },
  released: { momentaryMax: -26.0, peakDb: -16.3 },
  landed: { momentaryMax: -26.0, peakDb: -17.6 },
  reply: { momentaryMax: -28.0, peakDb: -17.8 },
  launched: { momentaryMax: -31.0, peakDb: -17.3 },
  step: { momentaryMax: -31.0, peakDb: -16.5 },
};
const DEFAULT_VOLUME = 0.4;

declare global {
  interface Window {
    Synth: typeof import("./synth");
  }
}

let browser: Browser | null = null;
let page: Page | null = null;

async function engineOnPage(): Promise<Page> {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "llv-synth-render-"));
  try {
    const entry = path.join(out, "entry.ts");
    fs.writeFileSync(entry, `import * as Synth from ${JSON.stringify(path.join(import.meta.dir, "synth.ts"))};\n(window as any).Synth = Synth;\n`);
    const built = await Bun.build({ entrypoints: [entry], target: "browser", format: "esm", minify: false });
    if (!built.success) throw new Error(built.logs.map(String).join("\n"));
    const code = await built.outputs[0]!.text();
    browser = await chromium.launch(LAUNCH);
    const opened = await browser.newPage();
    await opened.setContent("<!doctype html><title>synth</title>");
    await opened.addScriptTag({ content: code, type: "module" });
    await opened.waitForFunction(() => Boolean(window.Synth));
    return opened;
  } finally {
    fs.rmSync(out, { recursive: true, force: true });
  }
}

const db = (linear: number) => 20 * Math.log10(linear);

/**
 * Where the design's renders started each sound: 0.3 s into the render, on
 * the meter's 100 ms grid. The momentary maximum of a short sound depends on
 * where its 400 ms windows fall (S7 reads 0.5 dB lower half a hop off the
 * grid), so the check measures under the same condition: the graph's 150 ms
 * settle plus this delay.
 */
const DESIGN_DELAY = 0.15;

describe("the synthesis engine, rendered in Chromium", () => {
  beforeAll(async () => {
    if (enabled) page = await engineOnPage();
  });
  afterAll(async () => {
    await browser?.close();
  });

  const renderAll = (delay: number) => page!.evaluate(async ({ ids, volume, delay }) => {
    const offline = (channels: number, length: number, rate: number) => new OfflineAudioContext(channels, length, rate);
    const out: Record<string, { momentaryMax: number; peakDb: number }> = {};
    for (const id of ids) out[id] = await window.Synth.renderThroughGraph(offline, id, { volume, palette: "wood", delay });
    return out;
  }, { ids: [...EVENT_SOUNDS], volume: DEFAULT_VOLUME, delay });

  browserTest("each palette-2 sound's loudness and peak match the design's table within 1 dB", async () => {
    expect(ACTIVE_PALETTE).toBe("wood");
    const measured = await renderAll(DESIGN_DELAY);
    const rows = EVENT_SOUNDS.map((id) => ({
      id,
      lufs: +measured[id]!.momentaryMax.toFixed(2),
      designLufs: PALETTE_2_TABLE[id].momentaryMax,
      peak: +measured[id]!.peakDb.toFixed(2),
      designPeak: PALETTE_2_TABLE[id].peakDb,
    }));
    console.log(JSON.stringify(rows));
    for (const row of rows) {
      expect({ id: row.id, lufsWithin1dB: Math.abs(row.lufs - row.designLufs) <= 1 }).toEqual({ id: row.id, lufsWithin1dB: true });
      expect({ id: row.id, peakWithin1dB: Math.abs(row.peak - row.designPeak) <= 1 }).toEqual({ id: row.id, peakWithin1dB: true });
      /* The limiter is there for overlaps only: no single sound reaches it. */
      expect(row.peak).toBeLessThan(-10);
    }
  });

  browserTest("the stored gains are what the engine measures, in both palettes", async () => {
    for (const palette of ["wood", "glass"] as PaletteId[]) {
      const gains = await page!.evaluate(async (which) => {
        const offline = (channels: number, length: number, rate: number) => new OfflineAudioContext(channels, length, rate);
        return window.Synth.calibrateSounds(offline, which);
      }, palette);
      console.log(palette, JSON.stringify(Object.fromEntries(Object.entries(gains).map(([id, gain]) => [id, +gain.toFixed(4)]))));
      for (const id of EVENT_SOUNDS) {
        const drift = Math.abs(db(CALIBRATED_GAIN[palette][id]) - db(gains[id]));
        expect({ palette, id, driftUnderTenthDb: drift < 0.1 }).toEqual({ palette, id, driftUnderTenthDb: true });
      }
    }
  });

  browserTest("a sound renders the same whenever it starts", async () => {
    /* Peaks at any start, on or off a render block; loudness at starts on the
       meter's 100 ms grid (see DESIGN_DELAY). */
    const runs = [];
    for (const delay of [0, 0.05, 0.13, 0.15, 0.35, 0.85]) runs.push({ delay, measured: await renderAll(delay) });
    for (const id of EVENT_SOUNDS) {
      const peaks = runs.map((run) => run.measured[id]!.peakDb);
      const lufs = runs.filter((run) => [0.05, 0.15, 0.35, 0.85].includes(run.delay)).map((run) => run.measured[id]!.momentaryMax);
      const peakSpread = Math.max(...peaks) - Math.min(...peaks);
      const lufsSpread = Math.max(...lufs) - Math.min(...lufs);
      expect({ id, peakSpreadUnderQuarterDb: peakSpread < 0.25 }).toEqual({ id, peakSpreadUnderQuarterDb: true });
      expect({ id, lufsSpreadUnderTenthDb: lufsSpread < 0.1 }).toEqual({ id, lufsSpreadUnderTenthDb: true });
    }
  });

  browserTest("the order of levels holds: S6 > S7 > S5 = S4 > S8 > S9 = S3, 2 LU apart", async () => {
    const measured = await renderAll(DESIGN_DELAY);
    const ladder: EventSoundId[][] = [["your-move"], ["fault"], ["released", "landed"], ["reply"], ["launched", "step"]];
    for (let i = 1; i < ladder.length; i++) {
      const quietestAbove = Math.min(...ladder[i - 1]!.map((id) => measured[id]!.momentaryMax));
      const loudestBelow = Math.max(...ladder[i]!.map((id) => measured[id]!.momentaryMax));
      expect({ rung: i, apart: +(quietestAbove - loudestBelow).toFixed(2) >= 1.9 }).toEqual({ rung: i, apart: true });
    }
  });
});
