/** Test-only TCP counting proxy for the two-install tests. Never imported by production. */
import net from "node:net";

/** Counts every byte on the TCP connections the sender opens to the receiver, both directions, headers included. */
export type Meter = { url: string; up: number; down: number; connections: number; requests: Buffer[]; close: () => void };

export async function meter(target: string): Promise<Meter> {
  const port = Number(new URL(target).port);
  const server = net.createServer((client) => {
    counts.connections++;
    const index = counts.requests.push(Buffer.alloc(0)) - 1;
    const upstream = net.connect(port, "127.0.0.1");
    client.on("data", (chunk: Buffer) => { counts.up += chunk.length; counts.requests[index] = Buffer.concat([counts.requests[index]!, chunk]); upstream.write(chunk); });
    upstream.on("data", (chunk: Buffer) => { counts.down += chunk.length; client.write(chunk); });
    client.on("end", () => upstream.end());
    upstream.on("end", () => client.end());
    client.on("error", () => upstream.destroy());
    upstream.on("error", () => client.destroy());
  });
  const counts: Meter = { url: "", up: 0, down: 0, connections: 0, requests: [], close: () => server.close() };
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  counts.url = `http://127.0.0.1:${(server.address() as net.AddressInfo).port}`;
  return counts;
}

/** M.9: an idle exchange costs at most 1 KiB on the wire, request and answer together. */
export const WIRE_BUDGET = 1024;
