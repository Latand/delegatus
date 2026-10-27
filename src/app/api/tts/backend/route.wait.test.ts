import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { configFilePath } from "@/lib/configDir";
import { withFileTransaction } from "@/lib/state/fileTransaction";

async function until(predicate: () => boolean, barrier = "voice writer"): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error(`${barrier} did not reach its barrier`);
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function serve(root: string) {
  const ready = path.join(root, "ready.json");
  for (const marker of [ready, `${ready}.signal`, `${ready}.timer`]) fs.rmSync(marker, { force: true });
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "writeWait.fixture.ts"), ready], {
    env: { ...process.env, XDG_CONFIG_HOME: root }, stdin: "pipe", stdout: "ignore", stderr: "pipe",
  });
  // Owned by the parent: a blocked fixture cannot run its own deadlock watchdog.
  const watchdog = setTimeout(() => { if (child.exitCode === null) child.kill("SIGKILL"); }, 15_000);
  const errors = new Response(child.stderr).text();
  try {
    await until(() => fs.existsSync(ready) || child.exitCode !== null);
    if (!fs.existsSync(ready)) throw new Error(`voice fixture exited: ${await errors}`);
  } catch (error) { clearTimeout(watchdog); if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; await errors; throw error; }
  const { port } = JSON.parse(fs.readFileSync(ready, "utf8"));
  return { child, ready, base: `http://127.0.0.1:${port}`, async stop() {
    clearTimeout(watchdog);
    if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; await errors;
  } };
}

async function hold(file: string) {
  let release!: () => void;
  let admitted!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const ready = new Promise<void>(resolve => { admitted = resolve; });
  const work = withFileTransaction(file, "test holds voice choice", async () => { admitted(); await gate; });
  await Promise.race([ready, work]);
  return async () => { release(); await work; };
}

const choices = [
  { name: "backend", file: "tts-backend", body: { backend: "soniox" }, expected: "soniox" },
  { name: "model", file: "tts-model-fishaudio", body: { backend: "fishaudio", model: "s2.1-pro" }, expected: "s2.1-pro" },
  { name: "voice", file: "tts-voice-soniox", body: { backend: "soniox", voice: "saved voice" }, expected: "saved voice" },
];
const post = (base: string, body: unknown) => fetch(base, { method: "POST", body: JSON.stringify(body),
  headers: { "content-type": "application/json" }, signal: AbortSignal.timeout(10_000) });
const tickets = (file: string) => fs.readdirSync(`${file}.write-locks`).filter(name => name.endsWith(".json")).sort();
const queued = (file: string) => tickets(file).length;

for (const choice of choices) test(`a queued POST refuses a same-process synchronous ${choice.name} writer before release`, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-mixed-"));
  const savedConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  const file = configFilePath(choice.file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "previous\n");
  const release = await hold(file);
  const syncBody = choice.name === "voice" ? { backend: "soniox", voice: "sync voice" }
    : choice.name === "model" ? { backend: "fishaudio", model: "s2.1-pro-free" }
    : { backend: "elevenlabs" };
  const syncExpected = choice.name === "voice" ? "sync voice" : choice.name === "model" ? "s2.1-pro-free" : "elevenlabs";
  let server: Awaited<ReturnType<typeof serve>> | undefined;
  let pending: Promise<Response> | undefined;
  try {
    server = await serve(root);
    pending = post(server.base, choice.body);
    // Observe a lost POST while the synchronous-call assertion is still pending.
    void pending.catch(() => undefined);
    // The owner lives in this process; both competing writers live in the child.
    await until(() => queued(file) === 2, "queued POST before synchronous write");
    const queuedTickets = tickets(file);
    const refusal = await (await post(`${server.base}/sync`, syncBody)).json();
    expect(refusal.refused).toBe(true);
    expect(refusal.message).toBe("the voice settings are busy");
    expect(tickets(file)).toEqual(queuedTickets);
    expect(fs.readFileSync(file, "utf8")).toBe("previous\n");
    // A refusal leaves the original FIFO admission intact and runnable.
    await release();
    const result = await (await pending).json();
    expect(result.status).toBe(200);
    expect(fs.readFileSync(file, "utf8")).toBe(`${choice.expected}\n`);
    const retry = await (await post(`${server.base}/sync`, syncBody)).json();
    expect(retry.refused).toBe(false);
    expect(fs.readFileSync(file, "utf8")).toBe(`${syncExpected}\n`);
    expect(fs.existsSync(`${file}.write-lock`)).toBe(false);
    expect(queued(file)).toBe(0);
    console.log(`voice-mixed ${choice.name} ${JSON.stringify({ refusalMs: refusal.elapsedMs, retryMs: retry.elapsedMs })}`);
  } finally {
    await release(); await server?.stop(); await Promise.allSettled(pending ? [pending] : []);
    if (savedConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

for (const choice of choices) test(`${choice.name} lock wait serves timers, requests and SIGTERM`, async () => {
  const measurements = [];
  for (let trial = 0; trial < 3; trial++) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-wait-"));
    const savedConfig = process.env.XDG_CONFIG_HOME;
    process.env.XDG_CONFIG_HOME = root;
    const file = configFilePath(choice.file);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "previous\n");
    const release = await hold(file);
    let server: Awaited<ReturnType<typeof serve>> | undefined;
    let resumeTimer: ReturnType<typeof setTimeout> | undefined;
    let response: Promise<Response> | undefined;
    try {
      server = await serve(root);
      response = post(server.base, choice.body);
      await until(() => queued(file) === 2);
      expect(fs.readFileSync(file, "utf8")).toBe("previous\n");
      // Delay only our fixture once: scheduling latency must not reject correct admission.
      if (trial === 1 && process.platform !== "win32") {
        server.child.kill("SIGSTOP");
        resumeTimer = setTimeout(() => { server!.child.kill("SIGCONT"); }, 200);
      }
      server.child.stdin.write("probe\n");
      server.child.stdin.flush();
      const sentAt = performance.now();
      server.child.kill("SIGTERM");
      await until(() => fs.existsSync(`${server!.ready}.signal`), "SIGTERM before lock release");
      const signalDelayMs = performance.now() - sentAt;
      await until(() => fs.existsSync(`${server!.ready}.timer`), "timer before lock release");
      const pingStart = performance.now();
      const ping = await fetch(server.base, { signal: AbortSignal.timeout(10_000) });
      await ping.json();
      expect(ping.status).toBe(200);
      const pingMs = performance.now() - pingStart;
      // All three progress acknowledgements precede release of the external owner.
      expect(fs.readFileSync(file, "utf8")).toBe("previous\n");
      expect(fs.existsSync(`${file}.write-lock`)).toBe(true);
      expect(queued(file)).toBe(2);
      await release();
      const result = await (await response).json();
      expect(result.status).toBe(200);
      // The same response reader must accept the real persisted choice.
      if (choice.name === "backend") expect(result.body.backend).toBe(choice.expected);
      else expect(result.body.options.find((option: { id: string }) => option.id === choice.body.backend)[choice.name]).toBe(choice.expected);
      expect(fs.readFileSync(file, "utf8")).toBe(`${choice.expected}\n`);
      expect(fs.existsSync(`${file}.write-lock`)).toBe(false);
      expect(queued(file)).toBe(0);
      measurements.push({ asyncWait: result.waits.some((wait: { site: string; synchronous: boolean; label: string }) =>
        wait.site === "file-transaction" && !wait.synchronous && wait.label === "voice-settings.write"), timerMs: result.timerAtMs, signalDelayMs,
        pingMs, writeMs: result.returnedAtMs });
    } finally {
      clearTimeout(resumeTimer);
      if (server?.child.exitCode === null && process.platform !== "win32") server.child.kill("SIGCONT");
      await release(); await Promise.allSettled(response ? [response] : []); await server?.stop();
      if (savedConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedConfig;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  console.log(`voice-wait ${choice.name} ${JSON.stringify(measurements)}`);
  for (const sample of measurements) {
    expect(sample.asyncWait).toBe(true);
  }
}, 30_000);


test("queued HTTP writers keep the transfer lock's order", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-order-"));
  const savedConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  const file = configFilePath("tts-backend");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const release = await hold(file);
  let server: Awaited<ReturnType<typeof serve>> | undefined;
  const pending: Promise<Response>[] = [];
  try {
    server = await serve(root);
    const ownerTickets = tickets(file);
    pending.push(post(server.base, { backend: "soniox" }));
    await until(() => queued(file) === 2);
    const firstTicket = tickets(file).find(ticket => !ownerTickets.includes(ticket))!;
    pending.push(post(server.base, { backend: "elevenlabs" }));
    await until(() => queued(file) === 3);
    const secondTicket = tickets(file).find(ticket => !ownerTickets.includes(ticket) && ticket !== firstTicket)!;
    const ordered = [{ ticket: firstTicket, backend: "soniox" }, { ticket: secondTicket, backend: "elevenlabs" }]
      .sort((a, b) => a.ticket < b.ticket ? -1 : 1);
    expect(fs.existsSync(file)).toBe(false);
    await release();
    const results = await Promise.all(pending.map(async response => (await response).json()));
    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect(results.map(result => result.body.backend)).toEqual(["soniox", "elevenlabs"]);
    expect(fs.readFileSync(file, "utf8")).toBe(`${ordered[1]!.backend}\n`);
    expect(queued(file)).toBe(0);
  } finally {
    await release(); await Promise.allSettled(pending); await server?.stop();
    if (savedConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);

test("a killed synchronous owner is recovered by a serving writer", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "voice-crash-"));
  const savedConfig = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = root;
  const file = configFilePath("tts-backend");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, "openai\n");
  const ready = path.join(root, "holder-ready");
  const holder = Bun.spawn([process.execPath, path.join(import.meta.dir, "writeWait.fixture.ts"), ready, "hold", file], {
    env: { ...process.env }, stdin: "pipe", stdout: "ignore", stderr: "pipe",
  });
  const errors = new Response(holder.stderr).text();
  let server: Awaited<ReturnType<typeof serve>> | undefined;
  let pending: Promise<Response> | undefined;
  try {
    await until(() => fs.existsSync(ready) || holder.exitCode !== null);
    expect(fs.existsSync(ready)).toBe(true);
    server = await serve(root);
    pending = post(server.base, { backend: "soniox" });
    await until(() => queued(file) === 2);
    expect(fs.readFileSync(file, "utf8")).toBe("openai\n");
    holder.kill("SIGKILL"); await holder.exited;
    const result = await (await pending).json();
    expect(result.status).toBe(200);
    expect(result.body.backend).toBe("soniox");
    expect(fs.readFileSync(file, "utf8")).toBe("soniox\n");
    expect(fs.existsSync(`${file}.write-lock`)).toBe(false);
    expect(queued(file)).toBe(0);
    // A fresh process reads the committed output after recovery.
    await server.stop(); server = await serve(root);
    expect((await (await fetch(server.base, { signal: AbortSignal.timeout(5_000) })).json()).backend).toBe("soniox");
  } finally {
    if (holder.exitCode === null) holder.kill("SIGKILL"); await holder.exited; await errors;
    await Promise.allSettled(pending ? [pending] : []); await server?.stop();
    if (savedConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedConfig;
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 20_000);
