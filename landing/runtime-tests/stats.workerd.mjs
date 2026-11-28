import assert from "node:assert/strict";
import { mkdtemp, open, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { build } from "esbuild";
import { convertV4MiniflareOptions, Log, LogLevel, Miniflare } from "miniflare";
import { authenticator, enrollmentSecret, fixtureInstallId, forgedCookie, testToken } from "./authenticator.mjs";

const directory = fileURLToPath(new URL("../", import.meta.url));
const config = JSON.parse(await readFile(new URL("../wrangler.jsonc", import.meta.url), "utf8"));
const { STATS_ORIGIN: origin, STATS_RP_ID: rp } = config.vars;
const { outputFiles: [bundle] } = await build({
  entryPoints: [join(directory, "entry.ts")],
  bundle: true, external: ["cloudflare:*"], format: "esm", target: "es2022", write: false,
});

const binding = config.durable_objects.bindings[0];
const name = "stats-fixture";
async function runtime({ persist, redirect = false } = {}) {
  const calls = [];
  const firstImport = Promise.withResolvers();
  const mf = new Miniflare(convertV4MiniflareOptions({
    modules: true, script: bundle.text, compatibilityDate: config.compatibility_date,
    name, cf: false, port: 0, log: new Log(LogLevel.NONE),
    durableObjects: { [binding.name]: { className: binding.class_name, useSQLite: true } },
    resourcePersistencePath: persist, unsafeInspectDurableObjects: true,
    versionMetadata: config.version_metadata.binding,
    bindings: {
      ...config.vars, STATS_ENROLLMENT: await enrollmentSecret(testToken, Date.now()),
      ...(redirect ? { STATS_ACCOUNT_ID: "a".repeat(32), STATS_AE_TOKEN: "fixture history credential" } : {}),
    },
    outboundService: async req => {
      const url = new URL(req.url);
      calls.push(url.origin);
      assert.ok(redirect);
      assert.equal(url.origin, "https://api.cloudflare.com");
      assert.ok(url.pathname.endsWith("/analytics_engine/sql"));
      assert.equal(req.method, "POST");
      assert.equal(req.headers.get("authorization"), "Bearer fixture history credential");
      if (calls.length === 2) firstImport.resolve();
      return new Response(null, { status: 307, headers: { Location: "https://redirect.example/stats" } });
    },
  }));
  const fetch = (path, init) => mf.dispatchFetch(new URL(path, origin), { redirect: "manual", ...init });
  const post = (path, body, headers) => fetch(path, {
    method: "POST",
    headers: { Origin: origin, ...(body === undefined ? {} : { "Content-Type": "application/json" }), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const form = (path, cookie, params = {}) => fetch(path, {
    method: "POST", headers: { Origin: origin, Cookie: cookie, "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
  return {
    mf, calls, fetch, post, form, firstImport: firstImport.promise,
    storage: () => mf.unsafeGetDurableObjectStorage(name, binding.class_name, { name: "stats" }),
  };
}

function cookie(response) {
  assert.equal(response.status, 204);
  const value = response.headers.get("set-cookie");
  assert.match(value, /^__Host-dlg_stats=[\w-]{43}; Path=\/; Max-Age=7776000; Secure; HttpOnly; SameSite=Strict$/);
  return value.split(";")[0];
}

async function refuse(response, status) {
  assert.equal(response.status, status);
  assert.equal(response.headers.get("set-cookie"), null);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.doesNotMatch(await response.text(), /Active installs|Newest ping|Swarm rule usage/);
}

async function loginProof(r, device) {
  const options = await r.post("/stats/login/options");
  assert.equal(options.status, 200);
  return device.assertion(await options.json());
}

async function enroll(r) {
  const device = await authenticator(origin, rp);
  const options = await r.post("/stats/enroll/options", { token: testToken });
  assert.equal(options.status, 200);
  const proof = await device.registration(await options.json(), testToken);
  const responses = await Promise.all([r.post("/stats/enroll/finish", proof), r.post("/stats/enroll/finish", proof)]);
  assert.deepEqual(responses.map(r => r.status).sort(), [204, 403]);
  await refuse(responses.find(r => r.status === 403), 403);
  await refuse(await r.post("/stats/enroll/options", { token: testToken }), 403);
  await refuse(await r.post("/stats/enroll/finish", proof), 403);
  return { device, cookie: cookie(responses.find(r => r.status === 204)) };
}

test("real SQLite runs enrollment, both stats paths, and persistent replay guards", async () => {
  const persist = await mkdtemp(join(tmpdir(), "stats-db-"));
  let r;
  try {
    r = await runtime({ persist });
    for (const path of ["/stats", "/stats/"]) {
      await refuse(await r.fetch(path), 401);
      await refuse(await r.fetch(path, { headers: { Cookie: forgedCookie } }), 401);
    }
    const first = await enroll(r);
    assert.equal((await r.post("/api/ping", {
      id: fixtureInstallId(1), v: "1.2.3", os: "linux", arch: "x64", kind: "checkout",
    })).status, 204);
    assert.equal((await r.post("/api/event", { event: "demo_start", lang: "en" })).status, 204);
    const day = new Date().toISOString().slice(0, 10);
    await (await r.storage()).exec("INSERT INTO swarm_usage_days VALUES (?, 'fixture-rule', 4, 10, 3, 1, 1)", day);
    const proof = await loginProof(r, first.device);
    const finishes = await Promise.all([r.post("/stats/login/finish", proof), r.post("/stats/login/finish", proof)]);
    assert.deepEqual(finishes.map(result => result.status).sort(), [204, 401]);
    const session = cookie(finishes.find(result => result.status === 204));
    await refuse(finishes.find(result => result.status === 401), 401);

    await r.mf.dispose();
    r = await runtime({ persist });
    await refuse(await r.post("/stats/login/finish", proof), 401);
    await refuse(await r.post("/stats/enroll/options", { token: testToken }), 403);
    for (const path of ["/stats", "/stats/"]) {
      const page = await r.fetch(path, { headers: { Cookie: session } });
      assert.equal(page.status, 200);
      const html = await page.text();
      for (const text of ["Today", "Last 7 days", "Last 30 days", ">1</strong>", "Daily active installs",
        "New installs per day", "Version", "1.2.3", "OS / architecture", "linux / x64", "Install kind",
        "checkout", "Landing actions per day", "demo start", "Newest ping:", "Swarm rule usage",
        "fixture-rule", "30.0%", "Access"]) assert.ok(html.includes(text), text);
      assert.doesNotMatch(html, /Data unavailable/);
      assert.ok(!html.includes(session));
    }
    const storage = await r.storage();
    function ageSessions(days) {
      const elapsed = days * 86_400_000;
      return storage.exec("UPDATE sessions SET created_at = ?, expires_at = ?", Date.now() - elapsed,
        Date.now() + 90 * 86_400_000 - elapsed);
    }
    for (const days of [30, 89]) {
      await ageSessions(days);
      assert.equal((await r.fetch("/stats/session", { headers: { Cookie: session } })).status, 204);
    }
    await ageSessions(90);
    await refuse(await r.fetch("/stats", { headers: { Cookie: session } }), 401);
    assert.deepEqual(r.calls, []);
  } finally {
    await r?.mf.dispose();
    await rm(persist, { recursive: true, force: true });
  }
});

test("logout, all-device sign-out, and passkey removal revoke their sessions in SQLite", async () => {
  const r = await runtime();
  try {
    const first = await enroll(r);
    const signIn = async () => cookie(await r.post("/stats/login/finish", await loginProof(r, first.device)));
    const second = await signIn();
    assert.equal((await r.form("/stats/logout", first.cookie)).status, 303);
    await refuse(await r.fetch("/stats", { headers: { Cookie: first.cookie } }), 401);
    assert.equal((await r.fetch("/stats/session", { headers: { Cookie: second } })).status, 204);
    const third = await signIn();
    assert.equal((await r.form("/stats/sessions/revoke", second)).status, 303);
    for (const revoked of [second, third]) await refuse(await r.fetch("/stats", { headers: { Cookie: revoked } }), 401);
    const fourth = await signIn();
    assert.equal((await r.form("/stats/passkeys/remove", fourth, { id: first.device.id })).status, 303);
    await refuse(await r.fetch("/stats", { headers: { Cookie: fourth } }), 401);
    await refuse(await r.post("/stats/login/finish", await loginProof(r, first.device)), 401);
  } finally {
    await r.mf.dispose();
  }
});

test("history redirect stays unfollowed in workerd", async () => {
  const r = await runtime({ redirect: true });
  try {
    const { cookie } = await enroll(r);
    await Promise.race([r.firstImport, delay(8000, undefined, { ref: false }).then(() => {
      throw new Error("The Durable Object import alarm did not run");
    })]);
    const html = await (await r.fetch("/stats", { headers: { Cookie: cookie } })).text();
    assert.deepEqual(r.calls, Array(2).fill("https://api.cloudflare.com"));
    assert.match(html, /Importing history/);
    assert.doesNotMatch(html, /fixture history credential|redirect\.example/);
  } finally {
    await r.mf.dispose();
  }
});

test("Chromium enrolls, restarts, resumes from an external link, and submits the Access forms", {
  skip: !process.env.CHROME_BIN || !process.env.STATS_RENDER_DIR,
  timeout: 90_000,
}, async () => {
  const { chromium } = await import("playwright-core");
  const r = await runtime();
  const scratch = await mkdtemp(join(tmpdir(), "stats-chrome-"));
  // Keep the singleton socket under the private scratch root, within Linux's Unix socket path limit.
  const directoryHandle = process.platform === "linux" ? await open(scratch) : undefined;
  const shortTmp = directoryHandle ? `/proc/${process.pid}/fd/${directoryHandle.fd}` : scratch;
  const renderDir = process.env.STATS_RENDER_DIR;
  const scenarios = ["import-unavailable", "import-pending", "import-stopped", "import-complete"];
  const files = process.env.STATS_FIXTURE_DIR ? new Map(await Promise.all(scenarios.map(async name => [
    `/fixture/${name}`, await readFile(join(process.env.STATS_FIXTURE_DIR, name + ".html"), "utf8"),
  ]))) : new Map();
  let context;
  let page;
  const seen = [];
  async function start() {
    context = await chromium.launchPersistentContext(join(scratch, "profile"), {
      env: { ...process.env, TMPDIR: shortTmp },
      executablePath: process.env.CHROME_BIN, headless: true,
      args: ["--no-sandbox", "--disable-background-networking", "--host-resolver-rules=MAP * ~NOTFOUND"],
    });
    await context.route("**/*", async route => {
      const req = route.request();
      const url = new URL(req.url());
      if (url.hostname === "sender.example") {
        await route.fulfill({ contentType: "text/html", body: `<a href="${origin}/stats">Open stats</a>` });
        return;
      }
      if (url.origin !== origin) { await route.abort(); return; }
      if (files.has(url.pathname)) {
        await route.fulfill({ contentType: "text/html", body: files.get(url.pathname) });
        return;
      }
      const headers = await req.allHeaders();
      const response = await r.fetch(url.pathname + url.search, {
        method: req.method(), headers, body: req.postDataBuffer() ?? undefined,
      });
      seen.push({ path: url.pathname, method: req.method(), origin: headers.origin, cookie: Boolean(headers.cookie),
        status: response.status });
      await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() });
    });
    page = context.pages()[0];
  }
  async function capture(name, selector) {
    if (selector) await page.locator(selector).scrollIntoViewIfNeeded();
    for (const width of [1280, 800, 390]) {
      await page.setViewportSize({ width, height: 900 });
      if (selector) await page.locator(selector).scrollIntoViewIfNeeded();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${name} overflows at ${width}`);
      await page.screenshot({ path: join(renderDir, `${name}-${width}.png`) });
    }
  }
  async function attachAuthenticator() {
    const cdp = await context.newCDPSession(page);
    await cdp.send("WebAuthn.enable");
    await cdp.send("WebAuthn.addVirtualAuthenticator", { options: {
      protocol: "ctap2", transport: "internal", hasResidentKey: true,
      hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true,
    } });
  }
  async function openEnrollment() {
    await page.goto(origin + "/stats/enroll#" + testToken);
    await page.getByRole("button", { name: "Create passkey" }).waitFor();
    assert.equal(page.url(), origin + "/stats/enroll");
  }
  async function openStats() {
    await page.getByRole("heading", { name: "Installation stats" }).waitFor();
  }
  try {
    await start();
    await page.goto(origin + "/stats");
    await page.getByRole("button", { name: "Sign in with passkey" }).waitFor();
    await capture("sign-in");
    const unsupported = await context.newPage();
    await unsupported.addInitScript(() => { Object.defineProperty(window, "PublicKeyCredential", { value: undefined }); });
    await unsupported.goto(origin + "/stats");
    await unsupported.getByRole("status").filter({ hasText: "This browser cannot use passkeys here." }).waitFor();
    const original = page;
    page = unsupported;
    await capture("sign-in-unsupported");
    await unsupported.close();
    page = original;

    await attachAuthenticator();
    await openEnrollment();
    await capture("enrollment");
    await page.getByRole("button", { name: "Create passkey" }).click();
    await openStats();
    const cookieRow = (await context.cookies()).find(row => row.name === "__Host-dlg_stats");
    assert.ok(cookieRow?.secure && cookieRow.httpOnly && cookieRow.sameSite === "Strict" && cookieRow.expires > Date.now() / 1000);
    await page.getByRole("button", { name: "Sign out", exact: true }).click();
    await page.getByRole("button", { name: "Sign in with passkey" }).click();
    await openStats();
    await openEnrollment();
    await page.getByRole("button", { name: "Create passkey" }).click();
    await page.getByRole("status").filter({ hasText: "already used" }).waitFor();
    await capture("enrollment-used");
    await context.close();

    await start();
    await page.goto("https://sender.example/");
    const previous = seen.length;
    await page.getByRole("link", { name: "Open stats" }).click();
    await openStats();
    assert.deepEqual(seen.slice(previous).filter(row => row.path.startsWith("/stats")).map(row => [row.path, row.cookie, row.status]), [
      ["/stats", false, 401], ["/stats/session", true, 204], ["/stats", true, 200],
    ]);
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await page.getByRole("button", { name: "Sign in with passkey" }).waitFor();
    for (const path of ["/stats/enroll/options", "/stats/enroll/finish", "/stats/login/options", "/stats/login/finish",
      "/stats/logout", "/stats/passkeys/remove"]) {
      assert.ok(seen.some(row => row.path === path && row.method === "POST" && row.origin === origin), path);
    }
    for (const [path] of files) {
      await page.goto(origin + path);
      await capture(path.split("/").at(-1), "section:has(h2:text-is('Access'))");
    }
  } finally {
    await context?.close();
    await r.mf.dispose();
    await directoryHandle?.close();
    await rm(scratch, { recursive: true, force: true });
  }
});
