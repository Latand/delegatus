import { float32ToPcm16 } from "@/lib/audio";

/** Start loading beside the permission prompt and token request. */
export function prepareDictationInput() {
  let ctx: AudioContext;
  try { ctx = new AudioContext({ sampleRate: 16_000 }); }
  catch { ctx = new AudioContext(); }
  const ready = ctx.audioWorklet && typeof AudioWorkletNode !== "undefined"
    ? ctx.audioWorklet.addModule("/audio/dictation-capture.js").then(() => true, () => false)
    : Promise.resolve(false);
  return { ctx, ready };
}

export class DictationInput {
  private readonly source: MediaStreamAudioSourceNode;
  private readonly node: AudioWorkletNode | ScriptProcessorNode;
  private stopped: (() => void) | null = null;
  private deadline: number | undefined;
  private closed = false;

  constructor(private ctx: AudioContext, stream: MediaStream, worklet: boolean, maxSamples: number,
    private samples: (chunk: Int16Array) => void, full: () => void, private failed: () => void) {
    this.source = ctx.createMediaStreamSource(stream);
    if (worklet) {
      const node = new AudioWorkletNode(ctx, "dictation-capture", { processorOptions: { maxSamples } });
      node.port.onmessage = ({ data }) => {
        if (this.closed) return;
        if (data instanceof Int16Array) {
          node.port.postMessage(data.length);
          this.samples(data);
        } else if (data === "full") full();
        else if (data === "stopped") this.stopped?.();
      };
      node.onprocessorerror = () => { if (!this.closed) this.failed(); };
      this.node = node;
    } else {
      const node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = event => this.samples(float32ToPcm16(event.inputBuffer.getChannelData(0)));
      this.node = node;
    }
    this.source.connect(this.node);
    this.node.connect(ctx.destination);
  }

  observe(observer: (count: number) => void) {
    this.samples = samples => observer(samples.length);
  }

  drain(done: () => void) {
    if (!("port" in this.node)) { done(); return; }
    // Port messages are ordered. The final short block precedes the acknowledgement.
    this.stopped = done;
    this.deadline = window.setTimeout(this.failed, 2000);
    this.node.port.postMessage("stop");
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.stopped = null;
    if (this.deadline !== undefined) window.clearTimeout(this.deadline);
    if ("port" in this.node) { this.node.port.close(); this.node.onprocessorerror = null; }
    else this.node.onaudioprocess = null;
    this.node.disconnect();
    this.source.disconnect();
    void this.ctx.close().catch(() => undefined);
  }
}
