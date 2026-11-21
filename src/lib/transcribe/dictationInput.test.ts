import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

function capture(maxSamples: number) {
  const delivered: (Int16Array | string)[] = [];
  class Processor {
    port = {
      onmessage: (_event: { data: unknown }) => {},
      postMessage: (message: Int16Array | string) => delivered.push(message),
    };
  }
  type Node = Processor & { process(inputs: Float32Array[][]): boolean };
  let processor!: new (options: { processorOptions: { maxSamples: number } }) => Node;
  // Execute the same module the browser loads, with the audio and UI queues separated.
  runInNewContext(readFileSync(new URL("../../../public/audio/dictation-capture.js", import.meta.url), "utf8"), {
    AudioWorkletProcessor: Processor, Int16Array,
    registerProcessor: (_name: string, ctor: typeof processor) => { processor = ctor; },
  });
  return { node: new processor({ processorOptions: { maxSamples } }), delivered };
}

test("audio quanta remain distinct while the UI is busy and Stop flushes the partial tail", () => {
  const { node, delivered } = capture(16000);
  const quantum = new Float32Array(128);
  for (let i = 0; i < 37; i++) {
    quantum.fill((i + 1) / 64);
    expect(node.process([[quantum]])).toBe(true);
  }
  node.port.onmessage({ data: "stop" });
  const pcm = delivered.flatMap(message => typeof message === "string" ? [] : [...message]);
  expect(pcm.length).toBe(37 * 128);
  for (let i = 0; i < 37; i++) expect(pcm.slice(i * 128, (i + 1) * 128)).toEqual(Array(128).fill(Math.trunc((i + 1) / 64 * 0x7fff)));
  expect(delivered.at(-1)).toBe("stopped");
  expect(node.process([[quantum]])).toBe(false);
});

test("a stalled page retains a bounded queue and gets the limit after the last sample", () => {
  const { node, delivered } = capture(2100);
  expect(node.process([[new Float32Array(4096)]])).toBe(false);
  expect(delivered.map(message => typeof message === "string" ? message : message.length)).toEqual([2048, 52, "full"]);
});

test("acknowledged blocks release space for a continuing recording", () => {
  const { node, delivered } = capture(3000);
  for (let i = 0; i < 5; i++) {
    expect(node.process([[new Float32Array(2048)]])).toBe(true);
    node.port.onmessage({ data: 2048 });
  }
  expect(delivered).toHaveLength(5);
});
