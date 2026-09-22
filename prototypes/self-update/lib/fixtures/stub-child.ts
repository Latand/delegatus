/* A stand-in for a managed process in processes.test.ts. STUB_MODE picks the
   behaviour: "serve" answers GET / with 200 and exits on SIGTERM,
   "ignore-term" serves but ignores SIGTERM (so only SIGKILL stops it), and
   "exit3" exits with code 3 at once. */
const mode = process.env.STUB_MODE ?? "serve";
if (mode === "exit3") {
  console.error("stub: exiting with 3");
  process.exit(3);
}
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: Number(process.env.PORT ?? 0),
  fetch: () => new Response("ok"),
});
console.log(`stub listening on ${server.port}`);
process.on("SIGTERM", () => {
  if (mode === "ignore-term") {
    console.log("stub: ignoring SIGTERM");
    return;
  }
  server.stop(true);
  process.exit(0);
});

export {};
