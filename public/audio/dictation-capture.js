// AudioWorklet global scope. Transfer owned PCM before the page's next paint.
class DictationCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.block = new Int16Array(2048);
    this.used = 0;
    this.inFlight = 0;
    this.limit = options.processorOptions.maxSamples;
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data === "stop") this.finish("stopped");
      else if (typeof data === "number") this.inFlight -= data;
    };
  }

  send() {
    if (!this.used) return;
    const samples = this.used === this.block.length ? this.block : this.block.slice(0, this.used);
    this.inFlight += samples.length;
    this.port.postMessage(samples, [samples.buffer]);
    this.block = new Int16Array(2048);
    this.used = 0;
  }

  finish(reason) {
    if (this.stopped) return;
    this.stopped = true;
    this.send();
    this.port.postMessage(reason);
  }

  process(inputs) {
    if (this.stopped) return false;
    const channel = inputs[0]?.[0];
    if (channel) {
      for (const value of channel) {
        const sample = Math.max(-1, Math.min(1, value));
        this.block[this.used++] = sample * (sample < 0 ? 0x8000 : 0x7fff);
        if (this.used === this.block.length) this.send();
        if (this.inFlight + this.used >= this.limit) {
          this.finish("full");
          return false;
        }
      }
    }
    return true;
  }
}
registerProcessor("dictation-capture", DictationCapture);
