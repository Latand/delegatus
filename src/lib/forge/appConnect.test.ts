import fs from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, expect, spyOn, test } from "bun:test";
import { checkEnvironment } from "../../../scripts/gate-cache";
import { createGateSandbox, isolatedEnvironment } from "../../../scripts/local-gate";
const original = { ...process.env };
const root = createGateSandbox();
Object.assign(process.env, isolatedEnvironment(root, checkEnvironment(original)));
delete process.env.LLV_SPAWN_CAPABILITY;
const { AppConnectService, APP_CONNECT_WINDOW_MS, APP_CONNECT_MAX_CHECKS, AppConnectError, setAppConnectServiceForTests, startAppConnectPoller } = await import("./appConnect");
const { AppConnectStore } = await import("./appConnectStore");
const { publishPrototype } = await import("@/lib/prototypeReview/store");
const { findSeatRound, mutateSeatRound } = await import("@/lib/prototypeReview/seatRounds");
const { declareForgeAppRepository, forgeAppRepositories } = await import("@/lib/git/agentForgeCredentials");
const { renderPrototypeTelegram, renderPrototypeTelegramSummary } = await import("@/lib/prototypeReview/telegramPost");
const { prototypePublishSchema } = await import("@/lib/prototypeReview/input");
const { APP_CONNECT_QUESTION } = await import("./appConnectForm");
const { fakeAppConnection, CONNECT_SOURCE, CONNECT_TARGET, CONNECT_NOW } = await import("./appConnect.fixture");
const { FORGE_APP_PERMISSIONS, FORGE_APP_ISSUE_PERMISSIONS, mintInstallationToken, revokeInstallationToken, connectRepository } = await import("../../../bin/forge-app-token.mjs");
import type { AppConnectPorts } from "./appConnect";
import type { AppPermissions } from "./appConnectTypes";
import type { PrototypeReviewRound } from "@/lib/prototypeReview/types";

afterAll(() => { for (const key of Object.keys(process.env)) if (!(key in original)) delete process.env[key]; Object.assign(process.env, original); fs.rmSync(root, { recursive: true, force: true }); });
beforeEach(() => Object.assign(process.env, isolatedEnvironment(fs.mkdtempSync(path.join(root, "case-")), checkEnvironment(original))));

function fixture(own = true) {
  const fake = fakeAppConnection();
  let now = CONNECT_NOW, allowed = true, traffic = true, requests = 0;
  const declaration = path.join(process.env.LLV_STATE_DIR!, "forge-app-repositories.json");
  fs.writeFileSync(declaration, JSON.stringify([CONNECT_SOURCE]));
  const initialItem = fake.items.get(CONNECT_SOURCE);
  const forms: PrototypeReviewRound[] = [], telegram: unknown[] = [], notifications: Array<{ state: string; requestId: string }> = [];
  const store = new AppConnectStore();
  const ports: AppConnectPorts = {
    now: () => now, requestId: () => (++requests).toString(16).padStart(32, "0"), ownsTraffic: () => traffic, discover: async (repository, options) => {
      try { return await fake.discover(repository, options); }
      catch (error) { throw new AppConnectError(error instanceof Error && /^[a-z_]+$/.test(error.message) ? error.message : "verification_failed", 503); }
    }, repository: async repository => ({ repository, id: 6 }), own: () => own,
    publish: async (input, row) => { const round = await publishPrototype(input, null, { conversationId: row.conversationId }, row.project); forms.push(round); return round; },
    telegram: async round => { telegram.push(renderPrototypeTelegram(round, [])); }, round: findSeatRound,
    close: row => { if (row.reviewId) mutateSeatRound(row.reviewId, round => { if (!round.decision) round.decision = { chosen: [], comment: row.state, at: new Date(now).toISOString(), decidedBy: { kind: "agent", conversationId: row.conversationId }, delivery: { state: "sent", clientMessageId: "close", conversationId: null, text: "" } }; }); },
    declare: (repository, beforeWrite) => declareForgeAppRepository(repository, declaration, beforeWrite),
    notify: async row => { notifications.push({ state: row.state, requestId: row.requestId }); return true; },
  };
  const caller = { conversationId: "conversation_connect_seat", project: "fixture-project", authorize: () => { if (!allowed) throw new AppConnectError("not_permitted", 403); } };
  let service = new AppConnectService(store, ports), sequence = 0;
  const ask = (permissions: AppPermissions = { ...FORGE_APP_PERMISSIONS }, clientRequestId = `connect-${++sequence}`) => service.request({ clientRequestId, repository: CONNECT_TARGET, permissions }, caller);
  return { fake, forms, telegram, notifications, store, ports, caller, ask, service: () => service,
    restart: () => { service = new AppConnectService(new AppConnectStore(), ports); },
    tick: () => service.tick(),
    advance: (ms = 30_000) => { now += ms; },
    setAllowed: (value: boolean) => { allowed = value; }, setTraffic: (value: boolean) => { traffic = value; },
    declarations: () => forgeAppRepositories(declaration), initialItem,
    decide(kind: "operator" | "member" | "agent" = "operator", option = 0, extra: Record<string, unknown> = {}) {
      const row = store.request(CONNECT_TARGET)!;
      mutateSeatRound(row.reviewId!, round => { round.decision = { chosen: [], comment: "", at: new Date(now).toISOString(),
        decidedBy: kind === "agent" ? { kind, conversationId: caller.conversationId } : kind === "member" ? { kind, memberId: "fixture-member" } : { kind },
        answers: [{ questionId: APP_CONNECT_QUESTION, options: [option] }],
        delivery: { state: "sent", clientMessageId: "fixture-decision", conversationId: caller.conversationId, text: "" }, ...extra }; });
    },
  };
}

test("a second repository on a different installation stores, proves, declares and keeps the source intact", async () => {
  const f = fixture();
  const first = await f.ask();
  expect(first.state).toBe("awaiting_click");
  expect(f.declarations()).toEqual([CONNECT_SOURCE]);
  const link = new URL(f.forms[0]!.questions![0]!.links![0]!.href);
  expect(link.searchParams.has("suggested_target_id")).toBe(true);
  expect(link.searchParams.getAll("repository_ids[]")).toHaveLength(1);
  expect(await f.ask(undefined, "connect-1")).toEqual(first);
  f.fake.set({ installed: true, covered: true });
  f.restart();
  f.advance(); await f.tick();
  expect(f.store.request(CONNECT_TARGET)?.state).toBe("connected");
  expect(f.fake.items.get(CONNECT_SOURCE)).toBe(f.initialItem);
  expect(JSON.parse(f.fake.items.get(CONNECT_TARGET)!).installation_id).toBe(f.fake.targetInstallation);
  expect(f.declarations()).toEqual([CONNECT_SOURCE, CONNECT_TARGET]);
  for (const repository of [CONNECT_SOURCE, CONNECT_TARGET]) {
    const issued = await mintInstallationToken(repository, f.fake.ports);
    await revokeInstallationToken(issued, f.fake.ports);
  }
  const before = f.fake.calls.filter(call => call.method !== "GET").length;
  expect((await f.ask()).state).toBe("connected");
  expect(f.fake.calls.filter(call => call.method !== "GET")).toHaveLength(before);
  expect(f.forms).toHaveLength(1);
  expect(f.notifications.filter(n => n.state === "connected")).toHaveLength(1);
  expect(JSON.stringify([first, f.forms, f.telegram, f.notifications, f.fake.audit])).not.toContain(f.fake.pem);
});

test("a private App publishes two ordered links once; its owner needs only installation", async () => {
  const f = fixture(); f.fake.set({ privateApp: true });
  expect((await f.ask()).prerequisite).toBe("app_private");
  const links = f.forms[0]!.questions![0]!.links!;
  expect(links).toHaveLength(2);
  expect(new URL(links[0]!.href).pathname).toBe("/settings/apps/example-app");
  expect(new URL(links[1]!.href).pathname.endsWith("/installations/new/permissions")).toBe(true);
  f.fake.set({ privateApp: false, covered: true, installed: true });
  f.advance(); await f.tick();
  expect(f.store.request(CONNECT_TARGET)?.state).toBe("connected");
  expect(f.forms).toHaveLength(1);
  f.fake.set({ privateApp: true });
  const ownerDiscovery = await f.fake.discover(CONNECT_SOURCE, { permissions: { ...FORGE_APP_PERMISSIONS } });
  expect(ownerDiscovery.context.prerequisite).toBe("none");
});

test.each([false, true])("missing permission request distinguishes App registration and installation acceptance: app granted %s", async appGranted => {
  const f = fixture();
  f.fake.set({ covered: true, installed: true, registrationPermissions: appGranted ? { ...FORGE_APP_PERMISSIONS, issues: "write" } : { ...FORGE_APP_PERMISSIONS } });
  const asked = await f.ask({ ...FORGE_APP_ISSUE_PERMISSIONS });
  expect(asked.state).toBe("missing_permissions");
  expect(asked.missingPermissions).toEqual(["issues"]);
  expect(asked.missingAppPermissions).toEqual(appGranted ? [] : ["issues"]);
  const links = f.forms[0]!.questions![0]!.links!;
  expect(links).toHaveLength(appGranted ? 1 : 2);
  if (!appGranted) expect(links[0]!.href).toBe("https://github.com/settings/apps/example-app");
  expect(new URL(links.at(-1)!.href).pathname.startsWith("/settings/installations/")).toBe(true);
  // Grant arriving without the explicit permission confirmation cannot activate it.
  f.fake.set({ permissions: { ...FORGE_APP_PERMISSIONS, issues: "write" }, registrationPermissions: { ...FORGE_APP_PERMISSIONS, issues: "write" } });
  f.advance(); await f.tick();
  expect(f.store.request(CONNECT_TARGET)?.state).toBe("awaiting_answer");
  expect(f.fake.items.has(CONNECT_TARGET)).toBe(false);
  f.decide(); f.restart(); f.advance(); await f.tick();
  expect(f.store.request(CONNECT_TARGET)?.state).toBe("connected");
  expect(f.forms).toHaveLength(1);
  expect(f.fake.calls.filter(c => c.method === "POST").map(c => c.body)).toEqual([{ repositories: ["other-repo"], permissions: { ...FORGE_APP_ISSUE_PERMISSIONS } }]);
});

test("a permission never granted expires naming the remaining keys across restart", async () => {
  const f = fixture(); f.fake.set({ covered: true, installed: true });
  await f.ask({ ...FORGE_APP_ISSUE_PERMISSIONS }); f.decide();
  f.advance(APP_CONNECT_WINDOW_MS); f.restart(); await f.tick();
  const row = f.store.request(CONNECT_TARGET)!;
  expect(row.state).toBe("expired"); expect(row.discovery.missingPermissions).toEqual(["issues"]);
  expect(f.fake.items.has(CONNECT_TARGET)).toBe(false); expect(f.declarations()).toEqual([CONNECT_SOURCE]);
  expect(f.notifications.filter(n => n.state === "expired")).toHaveLength(1);
});

test("poll counters survive restart, enforce the cap and expire without an installation", async () => {
  const f = fixture(); await f.ask();
  for (let check = 1; check < APP_CONNECT_MAX_CHECKS; check++) { f.advance(1); await f.ask(); if (check % 50 === 0) f.restart(); }
  expect(f.store.request(CONNECT_TARGET)?.checks).toBe(APP_CONNECT_MAX_CHECKS);
  const calls = f.fake.calls.length;
  f.restart(); await f.ask(); expect(f.fake.calls).toHaveLength(calls);
  f.advance(APP_CONNECT_WINDOW_MS); await f.tick();
  expect(f.store.request(CONNECT_TARGET)?.state).toBe("expired");
  expect(f.declarations()).toEqual([CONNECT_SOURCE]);
  f.fake.set({ covered: true, installed: true });
  expect((await f.ask()).state).toBe("connected"); expect(f.forms).toHaveLength(1);
});

test("another project's installation needs a person; agent and recommendation decisions grant nothing", async () => {
  const f = fixture(false); await f.ask(); f.fake.set({ covered: true, installed: true });
  f.advance(); await f.tick(); expect(f.store.request(CONNECT_TARGET)?.state).toBe("awaiting_answer");
  f.decide("agent"); f.advance(); await f.tick(); expect(f.fake.items.has(CONNECT_TARGET)).toBe(false);
  f.decide("operator", 0, { skipped: true }); f.advance(); await f.tick(); expect(f.fake.items.has(CONNECT_TARGET)).toBe(false);
  f.decide("operator", 0, { answers: [{ questionId: APP_CONNECT_QUESTION, options: [], other: true }] }); f.advance(); await f.tick(); expect(f.fake.items.has(CONNECT_TARGET)).toBe(false);
  f.decide("member"); f.advance(); await f.tick(); expect(f.store.request(CONNECT_TARGET)?.state).toBe("connected");
});

test("cancel is terminal even if installation appears later", async () => {
  const f = fixture(); await f.ask(); f.decide("operator", 1); f.advance(); await f.tick();
  f.fake.set({ covered: true, installed: true }); f.restart(); f.advance(); await f.tick();
  expect(f.store.request(CONNECT_TARGET)?.state).toBe("cancelled"); expect(f.fake.items.has(CONNECT_TARGET)).toBe(false);
});

test("account installation without coverage replaces the form once and a broad token fails proof", async () => {
  const f = fixture(); await f.ask(); f.fake.set({ installed: true }); f.advance(); await f.tick();
  expect(f.store.request(CONNECT_TARGET)?.state).toBe("missing_repository"); expect(f.forms).toHaveLength(2);
  f.restart(); f.advance(); await f.tick(); expect(f.forms).toHaveLength(2);
  f.fake.set({ covered: true, broadToken: true }); f.advance(); await f.tick();
  expect(f.store.request(CONNECT_TARGET)?.state).toBe("verification_failed"); expect(f.declarations()).toEqual([CONNECT_SOURCE]);
  f.fake.set({ broadToken: false }); f.restart(); f.advance(); await f.tick();
  expect(f.store.request(CONNECT_TARGET)?.state).toBe("connected");
});

test("pending owner, network failure and lost release keep credentials unchanged", async () => {
  const f = fixture(); f.fake.set({ pending: true }); expect((await f.ask()).state).toBe("awaiting_owner");
  f.fake.set({ unreachable: true }); f.advance(); await f.tick(); expect(f.store.request(CONNECT_TARGET)?.state).toBe("awaiting_owner");
  expect(f.fake.items.has(CONNECT_TARGET)).toBe(false);
  f.setTraffic(false); const count = f.fake.calls.length; f.advance(); await f.tick(); expect(f.fake.calls).toHaveLength(count);
});

test("authority and cancellation are rechecked after a held GitHub read", async () => {
  const f = fixture(); await f.ask();
  const discover = f.ports.discover;
  f.ports.discover = async (repository, options) => { const answer = await discover(repository, options); f.setAllowed(false); return answer; };
  await expect(f.ask()).rejects.toMatchObject({ code: "not_permitted" });
  expect(f.fake.items.has(CONNECT_TARGET)).toBe(false);
  f.setAllowed(true);
  f.ports.discover = async (repository, options) => { const answer = await discover(repository, options); f.decide("operator", 1); return answer; };
  f.fake.set({ covered: true, installed: true }); f.advance(); await f.tick();
  expect(f.store.request(CONNECT_TARGET)?.state).toBe("cancelled"); expect(f.declarations()).toEqual([CONNECT_SOURCE]);
});

test("server links survive Telegram's compact fallback; agents cannot supply links", async () => {
  const f = fixture(); f.fake.set({ privateApp: true }); await f.ask();
  const round = f.forms[0]!;
  const full = renderPrototypeTelegram(round, []), compact = renderPrototypeTelegramSummary(round, []);
  for (const link of round.questions![0]!.links!) for (const rendered of [full, compact]) {
    expect(rendered.markdown).toContain(`<${link.href}>`); expect(rendered.plainText).toContain(link.href);
  }
  expect(prototypePublishSchema.safeParse({ clientRequestId: "hostile-links", title: "Fixture", questions: round.questions }).success).toBe(false);
  for (const value of ["example-owner/.", "example-owner/..", "https://example.invalid/a/b", "example-owner/%2e%2e"]) expect(connectRepository(value)).toBeNull();
  expect(connectRepository("example-owner/example-repo", "another-owner")).toBeNull();
  expect(connectRepository("example-repo", "example-owner")).toBe(CONNECT_SOURCE);
});

test("an unreadable repository id uses the plain link without selecting all repositories", async () => {
  const f = fixture(); f.ports.repository = async repository => ({ repository, id: null });
  expect((await f.ask()).preselected).toBe(false);
  expect(f.forms[0]!.questions![0]!.links![0]!.href).toBe("https://github.com/apps/example-app/installations/new");
});

test("a request naming only issues retains the existing metadata token policy", async () => {
  const f = fixture(); f.fake.set({ installed: true, covered: true });
  expect((await f.ask({ issues: "write" })).missingPermissions).toEqual(["issues"]);
  f.decide(); f.fake.set({ permissions: { ...FORGE_APP_PERMISSIONS, issues: "write" }, registrationPermissions: { ...FORGE_APP_PERMISSIONS, issues: "write" } });
  f.advance(); await f.tick();
  expect(f.store.request(CONNECT_TARGET)?.state).toBe("connected");
  expect(f.fake.calls.filter(c => c.method === "POST").map(c => c.body)).toEqual([{ repositories: ["other-repo"], permissions: { issues: "write", metadata: "read" } }]);
});

test("publication refuses unsafe server links before storing any round", async () => {
  const f = fixture(); await f.ask();
  for (const href of ["http://github.com/settings", "https://github.com.example.invalid/settings", "javascript:alert(1)", "https://github.com/a\n>bad"]) {
    const form = structuredClone(f.store.request(CONNECT_TARGET)!.form!);
    form.clientRequestId = "unsafe-server-link"; form.questions![0]!.links = [{ label: "Fixture", href }];
    await expect(f.ports.publish(form, f.store.request(CONNECT_TARGET)!)).rejects.toThrow();
  }
  expect(f.forms).toHaveLength(1);
});

test("declaration serializes concurrent additions, rejects corrupt state and checks authority inside its lock", async () => {
  const file = path.join(process.env.LLV_STATE_DIR!, "declarations.json");
  await Promise.all([declareForgeAppRepository(CONNECT_SOURCE, file), declareForgeAppRepository(CONNECT_TARGET, file), declareForgeAppRepository(CONNECT_SOURCE.toUpperCase(), file)]);
  expect(forgeAppRepositories(file).map(value => value.toLowerCase()).sort()).toEqual([CONNECT_SOURCE, CONNECT_TARGET]);
  fs.writeFileSync(file, "{}");
  await expect(declareForgeAppRepository(CONNECT_SOURCE, file)).rejects.toThrow();
  expect(fs.readFileSync(file, "utf8")).toBe("{}");
  const { withFileTransaction, withFileTransactionSync, FileTransactionBusyError } = await import("@/lib/state/fileTransaction");
  fs.writeFileSync(file, "[]");
  const pendingDeclaration = declareForgeAppRepository(CONNECT_SOURCE, file);
  expect(() => withFileTransactionSync(file, "fixture", () => { throw new Error("sync writer admitted"); })).toThrow(FileTransactionBusyError);
  await pendingDeclaration;
  fs.writeFileSync(file, "[]");
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; }), acquired = new Promise<void>(resolve => { entered = resolve; });
  const owner = withFileTransaction(file, "fixture", async () => { entered(); await held; });
  await acquired;
  let allowed = true;
  const write = declareForgeAppRepository(CONNECT_SOURCE, file, () => { if (!allowed) throw new Error("authority changed"); });
  allowed = false; release(); await owner;
  await expect(write).rejects.toThrow("authority changed");
  expect(forgeAppRepositories(file)).toEqual([]);
});

test("a failed declaration after proof recovers without a second form or completion report", async () => {
  const f = fixture(); await f.ask(); f.fake.set({ covered: true, installed: true });
  const declare = f.ports.declare;
  f.ports.declare = async () => { throw new Error("fixture interruption after proof"); };
  f.advance(); await f.tick();
  expect(f.fake.items.has(CONNECT_TARGET)).toBe(true); expect(f.declarations()).toEqual([CONNECT_SOURCE]);
  expect(f.store.request(CONNECT_TARGET)?.state).toBe("verification_failed");
  f.ports.declare = declare; f.restart(); f.advance(); await f.tick();
  expect(f.store.request(CONNECT_TARGET)?.state).toBe("connected");
  expect(f.forms).toHaveLength(1); expect(f.notifications.filter(n => n.state === "connected")).toHaveLength(1);
});

test("persisted budget is used by a fresh worker process", async () => {
  const f = fixture(); await f.ask();
  const row = f.store.request(CONNECT_TARGET)!;
  row.checks = APP_CONNECT_MAX_CHECKS; row.nextAt = CONNECT_NOW; f.store.put(row);
  const filename = path.join(process.env.HOME!, "restart-check.ts");
  fs.writeFileSync(filename, `
    import {AppConnectService} from ${JSON.stringify(new URL("./appConnect.ts", import.meta.url).href)};
    import {AppConnectStore} from ${JSON.stringify(new URL("./appConnectStore.ts", import.meta.url).href)};
    const store=new AppConnectStore(); let discovers=0;
    const service=new AppConnectService(store,{ now:()=>${CONNECT_NOW},ownsTraffic:()=>true,discover:async()=>{discovers++;throw Error('unexpected check');},
      round:()=>undefined,notify:async()=>true,close:()=>{},publish:async()=>{throw Error('duplicate form');},telegram:async()=>{},declare:async()=>{throw Error('unexpected declaration');},own:()=>true,repository:async()=>{throw Error('unexpected lookup');} });
    await service.tick(); console.log(JSON.stringify({checks:store.request(${JSON.stringify(CONNECT_TARGET)}).checks,discovers}));
  `);
  const child = Bun.spawn([process.execPath, filename], { cwd: process.cwd(), env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  expect({ exit, stderr }).toEqual({ exit: 0, stderr: "" });
  expect(JSON.parse(stdout)).toEqual({ checks: APP_CONNECT_MAX_CHECKS, discovers: 0 });
});

test("the production poller wakes an idle owner and advances a confirmed installation", async () => {
  const f = fixture(); await f.ask(); f.fake.set({ installed: true, covered: true }); f.advance();
  const originalTimer = globalThis.setTimeout;
  const handle = originalTimer(() => {}, 60_000); handle.unref();
  let wake: (() => void) | undefined;
  const timer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void, delay?: number, ...args: unknown[]) => {
    if (delay === 30_000) { wake = callback; return handle; }
    return originalTimer(callback, delay, ...args);
  }) as typeof setTimeout);
  let completed!: () => void;
  const notified = new Promise<void>(resolve => { completed = resolve; });
  const notify = f.ports.notify;
  f.ports.notify = async row => { const result = await notify(row); if (row.state === "connected") completed(); return result; };
  try {
    setAppConnectServiceForTests(f.service()); startAppConnectPoller();
    expect(wake).toBeDefined(); wake!(); await notified;
    expect(f.store.request(CONNECT_TARGET)?.state).toBe("connected");
  } finally { setAppConnectServiceForTests(undefined); timer.mockRestore(); clearTimeout(handle); }
});
