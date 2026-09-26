/*
 * Each demo frame gets a session store of its own, held in memory.
 *
 * The Viewer keeps a conversation's draft, its outbox and the receipts of what
 * was sent in sessionStorage. Every frame on the landing shares one origin and
 * one tab, so the browser hands all of them the same session store, and it
 * outlives a frame's reload: a request sent in the hero came back after a step
 * jump, a Replay or a language switch, already delivered and in the old
 * language. A frame here is one pass through the script, so its session lives
 * exactly as long as the frame's document.
 *
 * Imported first by demo.tsx, ahead of the Viewer, so no module reads the
 * shared store while it loads.
 */
class FrameStorage {
  #items = new Map<string, string>();
  get length() {
    return this.#items.size;
  }
  clear() {
    this.#items.clear();
  }
  getItem(key: string) {
    return this.#items.get(String(key)) ?? null;
  }
  key(index: number) {
    return [...this.#items.keys()][index] ?? null;
  }
  removeItem(key: string) {
    this.#items.delete(String(key));
  }
  setItem(key: string, value: string) {
    this.#items.set(String(key), String(value));
  }
}

Object.defineProperty(window, "sessionStorage", { value: new FrameStorage(), configurable: true });

export {};
