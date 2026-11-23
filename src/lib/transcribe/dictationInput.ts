import { float32ToPcm16 } from "@/lib/audio";

async function prepareWorklet(ctx: AudioContext, maxSamples: number): Promise<AudioWorkletNode | null> {
  if (!ctx.audioWorklet || typeof AudioWorkletNode !== "function") return null;
  try {
    const source = process.env.NEXT_PUBLIC_DICTATION_WORKLET_SOURCE;
    let installed = false;
    if (source && typeof URL.createObjectURL === "function") {
      let url: string | undefined;
      try {
        url = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
        await ctx.audioWorklet.addModule(url);
        installed = true;
      } catch { /* A content security policy can require the same-origin module. */ }
      finally { if (url) URL.revokeObjectURL(url); }
    }
    if (!installed) await ctx.audioWorklet.addModule("/audio/dictation-capture.js");
    return new AudioWorkletNode(ctx, "dictation-capture", { processorOptions: { maxSamples } });
  } catch {
    return null;
  }
}

/** Prepare the recorder beside the token request, before opening the microphone. */
export function prepareDictationInput(maxSamples: number) {
  let ctx: AudioContext;
  try { ctx = new AudioContext({ sampleRate: 16_000 }); }
  catch { ctx = new AudioContext(); }
  return { ctx, ready: prepareWorklet(ctx, maxSamples) };
}

export class DictationInput {
  private readonly source: MediaStreamAudioSourceNode;
  private readonly node: AudioWorkletNode | ScriptProcessorNode;
  private stopped: (() => void) | null = null;
  private deadline: number | undefined;
  private closed = false;

  constructor(private ctx: AudioContext, stream: MediaStream, worklet: AudioWorkletNode | null,
    private samples: (chunk: Int16Array) => void, full: () => void, private failed: () => void) {
    this.source = ctx.createMediaStreamSource(stream);
    if (worklet) {
      const node = worklet;
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
