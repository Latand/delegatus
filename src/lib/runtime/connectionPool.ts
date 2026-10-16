import net from "node:net";

const MAX_ENDPOINTS = 16;
const MAX_QUEUED = 128;
const IDLE_MS = 15_000;
type Connection = { socket: net.Socket; busy: boolean; timer?: ReturnType<typeof setTimeout> };
export type RuntimeConnectionLease = { socket: net.Socket; reused: boolean; release(reuse: boolean): void };
type Waiter = { signal: AbortSignal; resolve(lease: RuntimeConnectionLease): void; reject(error: Error): void; abort(): void };

/** Exclusive, FIFO leases: one frame in flight per socket. Long polls have
    their own sixteen slots, leaving four command slots available. A caller's
    single deadline includes time queued here. No mutation is replayed. */
class EndpointPool {
  private readonly connections = new Set<Connection>();
  private readonly waiting: Waiter[] = [];
  constructor(private readonly endpoint: string, private readonly limit: number, private readonly empty: () => void) {}
  acquire(signal: AbortSignal): Promise<RuntimeConnectionLease> {
    return new Promise((resolve, reject) => {
      if (signal.aborted || this.waiting.length >= MAX_QUEUED) return reject(new Error("runtime connection admission refused"));
      const waiter: Waiter = { signal, resolve, reject, abort: () => {
        const index = this.waiting.indexOf(waiter);
        if (index >= 0) this.waiting.splice(index, 1);
        reject(new Error("runtime connection admission cancelled"));
        this.prune();
      } };
      signal.addEventListener("abort", waiter.abort, { once: true });
      this.waiting.push(waiter);
      this.pump();
    });
  }
  private prune() { if (!this.connections.size && !this.waiting.length) this.empty(); }
  private pump(): void {
    while (this.waiting.length) {
      let connection = [...this.connections].find(item => !item.busy && !item.socket.destroyed && !item.socket.readableEnded && !item.socket.writableEnded);
      const reused = !!connection;
      if (!connection) {
        if (this.connections.size >= this.limit) return;
        const socket = net.createConnection(this.endpoint);
        connection = { socket, busy: false };
        this.connections.add(connection);
        const mine = connection;
        // Installed before any lease can write, and retained while idle.
        socket.on("error", () => socket.destroy());
        socket.on("end", () => socket.destroy());
        socket.once("close", () => {
          clearTimeout(mine.timer);
          this.connections.delete(mine);
          this.pump();
          this.prune();
        });
      }
      const waiter = this.waiting.shift()!;
      waiter.signal.removeEventListener("abort", waiter.abort);
      clearTimeout(connection.timer);
      connection.busy = true;
      connection.socket.ref();
      let released = false;
      const mine = connection;
      waiter.resolve({ socket: mine.socket, reused, release: reuse => {
        if (released) return;
        released = true;
        if (!reuse || mine.socket.destroyed || mine.socket.readableEnded || mine.socket.writableEnded) {
          mine.socket.destroy();
          return;
        }
        mine.busy = false;
        mine.socket.unref();
        mine.timer = setTimeout(() => mine.socket.destroy(), IDLE_MS);
        mine.timer.unref();
        this.pump();
      } });
    }
    this.prune();
  }
}
// Next compiles route modules more than once. The process owns one bounded
// map; closing the last connection evicts its endpoint and waiting queue.
const owner = process as typeof process & { __delegatusRuntimeConnections?: Map<string, EndpointPool> };
const pools = owner.__delegatusRuntimeConnections ??= new Map<string, EndpointPool>();
export function acquireRuntimeConnection(endpoint: string, longPoll: boolean, signal: AbortSignal): Promise<RuntimeConnectionLease> {
  if (signal.aborted) return Promise.reject(new Error("runtime connection admission cancelled"));
  const key = JSON.stringify([endpoint, longPoll]);
  let pool = pools.get(key);
  if (!pool) {
    if (pools.size >= MAX_ENDPOINTS) return Promise.reject(new Error("runtime endpoint admission refused"));
    pool = new EndpointPool(endpoint, longPoll ? 16 : 4, () => { if (pools.get(key) === pool) pools.delete(key); });
    pools.set(key, pool);
  }
  return pool.acquire(signal);
}
