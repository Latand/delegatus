import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { configFilePath } from "@/lib/configDir";
import { withFileTransaction } from "@/lib/state/fileTransaction";

async function until(predicate: () => boolean): Promise<void> {
  const deadline = performance.now() + 5_000;
  while (!predicate()) {
    if (performance.now() >= deadline) throw new Error("voice writer did not reach its barrier");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
}

async function serve(root: string) {
  const ready = path.join(root, "ready.json");
  fs.rmSync(ready, { force: true });
  const child = Bun.spawn([process.execPath, path.join(import.meta.dir, "writeWait.fixture.ts"), ready], {
    env: { ...process.env, XDG_CONFIG_HOME: root }, stdin: "ignore", stdout: "ignore", stderr: "pipe",
  });
  const errors = new Response(child.stderr).text();
  try {
    await until(() => fs.existsSync(ready) || child.exitCode !== null);
    if (!fs.existsSync(ready)) throw new Error(`voice fixture exited: ${await errors}`);
  } catch (error) { if (child.exitCode === null) child.kill("SIGKILL"); await child.exited; await errors; throw error; }
  const { port } = JSON.parse(fs.readFileSync(ready, "utf8"));
  return { child, base: `http://127.0.0.1:${port}`, async stop() {
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
const queued = (file: string) => fs.readdirSync(`${file}.write-locks`).filter(name => name.endsWith(".json")).length;

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
    let signalTimer: ReturnType<typeof setTimeout> | undefined;
    let releaseTimer: ReturnType<typeof setTimeout> | undefined;
    let response: Promise<Response> | undefined;
    try {
      server = await serve(root);
      response = post(server.base, choice.body);
      await until(() => queued(file) === 2);
      expect(fs.readFileSync(file, "utf8")).toBe("previous\n");
      let sentAt = 0;
      signalTimer = setTimeout(() => { sentAt = Date.now(); server!.child.kill("SIGTERM"); }, 50);
      releaseTimer = setTimeout(() => { void release(); }, 350);
      const pingStart = performance.now();
      expect((await fetch(server.base, { signal: AbortSignal.timeout(10_000) })).status).toBe(200);
      const pingMs = performance.now() - pingStart;
      const result = await (await response).json();
      expect(result.status).toBe(200);
      // The same response reader must accept the real persisted choice.
      if (choice.name === "backend") expect(result.body.backend).toBe(choice.expected);
      else expect(result.body.options.find((option: { id: string }) => option.id === choice.body.backend)[choice.name]).toBe(choice.expected);
      expect(fs.readFileSync(file, "utf8")).toBe(`${choice.expected}\n`);
      expect(fs.existsSync(`${file}.write-lock`)).toBe(false);
      expect(queued(file)).toBe(0);
      measurements.push({ asyncWait: result.waits.some((wait: { site: string; synchronous: boolean; label: string }) =>
        wait.site === "file-transaction" && !wait.synchronous && wait.label === "voice-settings.write"), timerMs: result.timerAtMs, signalDelayMs: result.signalAt - sentAt,
        pingMs, writeMs: result.returnedAtMs });
    } finally {
      clearTimeout(signalTimer); clearTimeout(releaseTimer);
      await release(); await Promise.allSettled(response ? [response] : []); await server?.stop();
      if (savedConfig === undefined) delete process.env.XDG_CONFIG_HOME; else process.env.XDG_CONFIG_HOME = savedConfig;
      fs.rmSync(root, { recursive: true, force: true });
    }
  }
  console.log(`voice-wait ${choice.name} ${JSON.stringify(measurements)}`);
  for (const sample of measurements) {
    expect(sample.timerMs).toBeGreaterThan(0);
    expect(sample.timerMs).toBeLessThan(100);
    expect(sample.signalDelayMs).toBeGreaterThanOrEqual(0);
    expect(sample.signalDelayMs).toBeLessThan(100);
    expect(sample.pingMs).toBeLessThan(100);
    expect(sample.timerMs).toBeLessThan(sample.writeMs);
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
    pending.push(post(server.base, { backend: "soniox" }));
    await until(() => queued(file) === 2);
    const lastTicketTime = Math.max(...fs.readdirSync(`${file}.write-locks`).map(name => Number(name.split("-")[0])));
    await until(() => Date.now() > lastTicketTime);
    pending.push(post(server.base, { backend: "elevenlabs" }));
    await until(() => queued(file) === 3);
    expect(fs.existsSync(file)).toBe(false);
    await release();
    const results = await Promise.all(pending.map(async response => (await response).json()));
    expect(results.map(result => result.status)).toEqual([200, 200]);
    expect(results.map(result => result.body.backend)).toEqual(["soniox", "elevenlabs"]);
    expect(fs.readFileSync(file, "utf8")).toBe("elevenlabs\n");
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
