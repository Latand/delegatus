/**
 * The delivery marker's own identity, computable on BOTH sides (#1950 round 2).
 *
 * Every structured Codex delivery stamps `dedup=sha256(<operation id>)` onto
 * the canonical structured-user record it writes (#1366). That token is the
 * only thing on a transcript record that says WHICH delivery wrote it — the
 * feed's whole join to the operator's own row hangs off it.
 *
 * The browser already holds the other half of that join for every delivery it
 * has heard an answer about: the admission response and the receipt stream
 * both carry the operation id beside the idempotency key the row is filed
 * under. So the join is a hash away, in the browser, with nothing to fetch —
 * which is what makes a record bindable in the very render it first appears
 * in, rather than after a round trip that the record can win.
 *
 * `node:crypto` cannot answer in a browser and `crypto.subtle` is asynchronous
 * and absent outside a secure context (the Viewer is served over plain HTTP on
 * the machine's own port), so the digest is computed here: synchronous, pure,
 * no platform surface at all beyond `TextEncoder`. `deliveryDedup.test.ts`
 * holds it to `node:crypto`'s own answer, because two implementations of one
 * hash is a join that silently stops matching.
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
]);

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

/** Lowercase hex SHA-256 of a string's UTF-8 bytes. */
export function sha256Hex(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const blocks = Math.ceil((bytes.length + 9) / 64);
  const padded = new Uint8Array(blocks * 64);
  padded.set(bytes);
  padded[bytes.length] = 0x80;
  const view = new DataView(padded.buffer);
  const bits = bytes.length * 8;
  /* The length is 64 bits wide. A message this side of 512 MB never fills the
     high word, and writing it anyway is what keeps the padding exact. */
  view.setUint32(padded.length - 8, Math.floor(bits / 0x1_0000_0000));
  view.setUint32(padded.length - 4, bits >>> 0);
  const h = new Uint32Array(INITIAL);
  const w = new Uint32Array(64);
  for (let block = 0; block < blocks; block += 1) {
    const offset = block * 64;
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i += 1) {
      const x = w[i - 15];
      const y = w[i - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
    }
    let a = h[0];
    let b = h[1];
    let c = h[2];
    let d = h[3];
    let e = h[4];
    let f = h[5];
    let g = h[6];
    let acc = h[7];
    for (let i = 0; i < 64; i += 1) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const choice = (e & f) ^ (~e & g);
      const t1 = (acc + s1 + choice + K[i] + w[i]) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const majority = (a & b) ^ (a & c) ^ (b & c);
      const t2 = (s0 + majority) >>> 0;
      acc = g;
      g = f;
      f = e;
      e = (d + t1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (t1 + t2) >>> 0;
    }
    h[0] = (h[0] + a) >>> 0;
    h[1] = (h[1] + b) >>> 0;
    h[2] = (h[2] + c) >>> 0;
    h[3] = (h[3] + d) >>> 0;
    h[4] = (h[4] + e) >>> 0;
    h[5] = (h[5] + f) >>> 0;
    h[6] = (h[6] + g) >>> 0;
    h[7] = (h[7] + acc) >>> 0;
  }
  let hex = "";
  for (let i = 0; i < 8; i += 1) hex += h[i].toString(16).padStart(8, "0");
  return hex;
}

/**
 * The token a delivered structured-user record carries for `operationId`.
 *
 * Hashing is the host's decision — the marker names the operation without
 * publishing it — and everything that has to recognise the marker agrees by
 * calling this.
 */
export function deliveryDedupToken(operationId: string): string {
  return sha256Hex(operationId);
}

/**
 * The key a native-queue delivery is stamped under: one per version of an
 * entry, so an edited message's record names the version that was sent. Its
 * token is `deliveryDedupToken(nativeQueueDeliveryKey(...))`, and the queue
 * route records a member's authorship under the key itself.
 */
export function nativeQueueDeliveryKey(entryId: string, revision: number): string {
  return `${entryId}-v${revision}`;
}

/** Whether a submission id has the shape of a native-queue delivery key. */
export const NATIVE_QUEUE_DELIVERY_KEY = /^[A-Za-z0-9_:.-]+-v[1-9][0-9]*$/;
