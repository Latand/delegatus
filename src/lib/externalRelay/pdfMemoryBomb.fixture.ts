process.stdout.write(`${JSON.stringify({ type: "started", workerPid: process.pid })}\n`);
const retained: Uint8Array[] = [];
for (;;) {
  const allocation = new Uint8Array(8 * 1024 * 1024);
  allocation.fill(1);
  retained.push(allocation);
}
