import { expect, test } from "bun:test";
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright-core";

import { translate, type Locale } from "@/lib/i18n";

const enabled = process.env.LLV_TEAM_PASSKEY_BROWSER_TEST === "1";
const browserTest = enabled ? test : test.skip;
const HOST = "passkey.review.test";
const SHOTS = process.env.PASSKEY_SCREENSHOT_DIR ?? path.join(os.homedir(), "Pictures/delegatus-review/passkey-errors");
const BUN = process.env.LLV_BUN_BIN ?? "bun";
const CHROME = process.env.CHROME_BIN ?? "/usr/bin/google-chrome-stable";

async function unusedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("port not assigned");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

async function listen(server: https.Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("TLS port not assigned");
  return address.port;
}

async function waitForServer(url: string, child: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Viewer exited: ${child.exitCode}`);
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch { /* wait for the process started by this test */ }
    await Bun.sleep(200);
  }
  throw new Error("Viewer did not start");
}

async function virtualAuthenticator(page: Page): Promise<void> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      ctap2Version: "ctap2_1",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}

async function pageFor(browser: Browser, locale: Locale, width: number): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ viewport: { width, height: 900 }, ignoreHTTPSErrors: true });
  await context.addInitScript((language) => localStorage.setItem("llv_lang", language), locale);
  return { context, page: await context.newPage() };
}

async function waitForText(locator: Locator, expected: string, timeoutMs = 12_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await locator.first().textContent({ timeout: 500 }).catch(() => ""))?.includes(expected)) return;
    await Bun.sleep(100);
  }
  throw new Error(`Expected visible text: ${expected}; found: ${await locator.first().textContent({ timeout: 500 }).catch(() => "<missing>")}`);
}

async function waitForEnabled(locator: Locator): Promise<void> {
  const deadline = Date.now() + 12_000;
  while (Date.now() < deadline) {
    if (await locator.isEnabled()) return;
    await Bun.sleep(100);
  }
  throw new Error("Passkey control stayed busy");
}

browserTest("production team pages register, sign out, sign in, and explain passkey failures", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "llv-passkey-browser-"));
  const state = path.join(root, "state");
  const config = path.join(root, "config");
  fs.mkdirSync(state);
  fs.mkdirSync(config);
  fs.mkdirSync(SHOTS, { recursive: true });
  const key = path.join(root, "tls.key");
  const cert = path.join(root, "tls.crt");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", `/CN=${HOST}`, "-keyout", key, "-out", cert], { stdio: "ignore" });

  const backendPort = await unusedPort();
  const proxy = https.createServer({ key: fs.readFileSync(key), cert: fs.readFileSync(cert) }, (request, response) => {
    const upstream = http.request({
      hostname: "127.0.0.1", port: backendPort, path: request.url, method: request.method,
      headers: { ...request.headers, "x-forwarded-proto": "https" },
    }, (incoming) => { response.writeHead(incoming.statusCode ?? 502, incoming.headers); incoming.pipe(response); });
    upstream.on("error", (error) => { response.writeHead(502); response.end(error.message); });
    request.pipe(upstream);
  });
  const tlsPort = await listen(proxy);
  const origin = `https://${HOST}:${tlsPort}`;
  const ipOrigin = `https://127.0.0.1:${tlsPort}`;
  const child = spawn(BUN, ["--bun", "node_modules/.bin/next", "start", "--hostname", "127.0.0.1", "--port", String(backendPort)], {
    cwd: process.cwd(), stdio: "ignore", env: {
      ...process.env, LLV_STATE_OWNER: "viewer", LLV_STATE_DIR: state, XDG_CONFIG_HOME: config,
      TMPDIR: "/var/tmp", LLV_TS_URL: `${origin}/?k=synthetic`, LLV_TS_HOST: HOST,
    },
  });
  let browser: Browser | undefined;
  try {
    await waitForServer(`http://127.0.0.1:${backendPort}/api/team/public`, child);
    browser = await chromium.launch({ executablePath: CHROME, headless: true, args: [
      "--no-sandbox", "--disable-dev-shm-usage", "--ignore-certificate-errors",
      `--host-resolver-rules=MAP ${HOST} 127.0.0.1`,
    ] });

    const owner = await pageFor(browser, "en", 1440);
    await virtualAuthenticator(owner.page);
    await owner.page.goto(`${origin}/team`);
    await owner.page.locator("[data-team-claim-name]").fill("Mira");
    await owner.page.locator("[data-team-claim-submit]").click();
    await owner.page.locator("[data-team-member-open]").first().click();
    await owner.page.locator("[data-team-add-passkey]").click();
    await waitForEnabled(owner.page.locator("[data-team-add-passkey]"));
    await waitForText(owner.page.locator("[data-team-member] [data-team-member-name]"), "Mira");
    await waitForText(owner.page.locator("[data-team-member]"), "1 passkey");

    await owner.page.locator("[data-team-add-passkey]").click();
    await waitForText(owner.page.getByRole("alert"), translate("en", "team.passkey.alreadyRegistered"));
    await waitForEnabled(owner.page.locator("[data-team-add-passkey]"));
    await owner.page.screenshot({ path: path.join(SHOTS, "profile-already-registered-1440-en.png") });

    await owner.page.getByRole("button", { name: translate("en", "common.close") }).click();
    await owner.page.locator("[data-team-sign-out]").click();
    await owner.page.locator('[data-sign-in-method="passkey"]').click();
    await owner.page.waitForURL(`${origin}/`);
    const signedInCookie = (await owner.context.cookies(origin)).find((cookie) => cookie.name === "llv_member");
    if (!signedInCookie) throw new Error("passkey sign-in did not set a member cookie");
    await owner.context.close();

    const empty = await pageFor(browser, "en", 1440);
    await virtualAuthenticator(empty.page);
    await empty.page.goto(`${origin}/sign-in`);
    await empty.page.locator('[data-sign-in-method="passkey"]').click();
    await waitForText(empty.page.locator("[data-passkey-note]"), translate("en", "team.passkey.noCredentialOrCancelled"));
    expect(await empty.page.locator('[data-team-auth="sign-in"] [role="alert"]').count()).toBe(0);
    await waitForEnabled(empty.page.locator('[data-sign-in-method="passkey"]'));
    await empty.page.screenshot({ path: path.join(SHOTS, "sign-in-no-credential-1440-en.png") });
    await empty.context.close();

    const cancelled = await pageFor(browser, "en", 390);
    await cancelled.context.addInitScript(() => {
      Object.defineProperty(navigator.credentials, "get", { configurable: true, value: async () => { throw new DOMException("dismissed", "AbortError"); } });
    });
    await cancelled.page.goto(`${origin}/sign-in`);
    await cancelled.page.locator('[data-sign-in-method="passkey"]').click();
    await waitForText(cancelled.page.locator("[data-passkey-note]"), translate("en", "team.passkey.cancelled"));
    expect(await cancelled.page.locator('[data-team-auth="sign-in"] [role="alert"]').allTextContents()).toEqual([]);
    await waitForEnabled(cancelled.page.locator('[data-sign-in-method="passkey"]'));
    await cancelled.page.screenshot({ path: path.join(SHOTS, "sign-in-cancelled-390-en.png") });
    await cancelled.context.close();

    const registrationCancelled = await pageFor(browser, "uk", 390);
    await registrationCancelled.context.addInitScript(() => {
      Object.defineProperty(navigator.credentials, "create", { configurable: true, value: async () => { throw new DOMException("dismissed", "AbortError"); } });
    });
    await registrationCancelled.context.addCookies([{ name: signedInCookie.name, value: signedInCookie.value, url: origin, secure: true, sameSite: "Lax" }]);
    await registrationCancelled.page.goto(`${origin}/team`);
    await registrationCancelled.page.locator("[data-team-member-open]").first().click();
    await registrationCancelled.page.locator("[data-team-add-passkey]").click();
    await waitForText(registrationCancelled.page.locator("[data-team-dialog=member] [data-passkey-note]"), translate("uk", "team.passkey.cancelled"));
    expect(await registrationCancelled.page.locator('[data-team-dialog="member"] [role="alert"]').allTextContents()).toEqual([]);
    await waitForEnabled(registrationCancelled.page.locator("[data-team-add-passkey]"));
    await registrationCancelled.page.screenshot({ path: path.join(SHOTS, "profile-cancelled-390-uk.png") });
    await registrationCancelled.context.close();

    const wrongAddress = await pageFor(browser, "en", 1440);
    await wrongAddress.context.addInitScript(() => {
      Object.defineProperty(navigator.credentials, "create", { configurable: true, value: async () => { throw new DOMException("origin mismatch", "SecurityError"); } });
    });
    await wrongAddress.context.addCookies([{ name: signedInCookie.name, value: signedInCookie.value, url: origin, secure: true, sameSite: "Lax" }]);
    await wrongAddress.page.goto(`${origin}/team`);
    await wrongAddress.page.locator("[data-team-member-open]").first().click();
    await wrongAddress.page.locator("[data-team-add-passkey]").click();
    await waitForText(wrongAddress.page.locator('[data-team-dialog="member"] [role="alert"]'), translate("en", "team.passkey.wrongAddress"));
    await waitForEnabled(wrongAddress.page.locator("[data-team-add-passkey]"));
    await wrongAddress.page.screenshot({ path: path.join(SHOTS, "profile-wrong-address-1440-en.png") });
    await wrongAddress.context.close();

    const timedOut = await pageFor(browser, "uk", 390);
    await timedOut.context.addInitScript(() => {
      Object.defineProperty(navigator.credentials, "get", { configurable: true, value: async () => { throw new DOMException("expired", "TimeoutError"); } });
    });
    await timedOut.page.goto(`${origin}/sign-in`);
    await timedOut.page.locator('[data-sign-in-method="passkey"]').click();
    await waitForText(timedOut.page.locator('[data-team-auth="sign-in"] [role="alert"]'), translate("uk", "team.passkey.timeout"));
    await waitForEnabled(timedOut.page.locator('[data-sign-in-method="passkey"]'));
    await timedOut.page.screenshot({ path: path.join(SHOTS, "sign-in-timeout-390-uk.png") });
    await timedOut.context.close();

    for (const locale of ["en", "uk"] as const) {
      for (const width of [390, 1440]) {
        const unavailable = await pageFor(browser, locale, width);
        await unavailable.page.goto(`${ipOrigin}/sign-in`);
        await waitForText(unavailable.page.locator("[data-passkey-unavailable]"), translate(locale, "team.passkey.unavailableAt", { address: origin }));
        expect(await unavailable.page.locator('[data-sign-in-method="passkey"]').count()).toBe(0);
        await unavailable.page.screenshot({ path: path.join(SHOTS, `sign-in-unavailable-${width}-${locale}.png`) });
        await unavailable.context.addCookies([{ name: signedInCookie.name, value: signedInCookie.value, url: ipOrigin, secure: true, sameSite: "Lax" }]);
        await unavailable.page.goto(`${ipOrigin}/team`);
        await unavailable.page.locator("[data-team-member-open]").first().click();
        await waitForText(unavailable.page.locator("[data-team-dialog=member] [data-passkey-unavailable]"), translate(locale, "team.passkey.unavailableAt", { address: origin }));
        expect(await unavailable.page.locator("[data-team-add-passkey]").count()).toBe(0);
        await unavailable.page.screenshot({ path: path.join(SHOTS, `profile-unavailable-${width}-${locale}.png`) });
        await unavailable.context.close();
      }
    }
    const plain = await pageFor(browser, "en", 390);
    await plain.page.goto(`http://127.0.0.1:${backendPort}/sign-in`);
    await waitForText(plain.page.locator("[data-passkey-unavailable]"), translate("en", "team.passkey.unavailableAt", { address: origin }));
    expect(await plain.page.locator('[data-sign-in-method="passkey"]').count()).toBe(0);
    await plain.context.close();

    for (const [scheme, loopbackOrigin] of [
      ["http", `http://localhost:${backendPort}`],
      ["https", `https://localhost:${tlsPort}`],
    ] as const) {
      for (const [locale, width] of [["en", 390], ["uk", 1440]] as const) {
        const loopback = await pageFor(browser, locale, width);
        await loopback.page.goto(`${loopbackOrigin}/sign-in`);
        await waitForText(loopback.page.locator("[data-passkey-unavailable]"), translate(locale, "team.passkey.unavailableAt", { address: origin }));
        expect(await loopback.page.locator('[data-sign-in-method="passkey"]').count()).toBe(0);
        await loopback.page.screenshot({ path: path.join(SHOTS, `sign-in-localhost-${scheme}-${width}-${locale}.png`) });
        await loopback.context.addCookies([{
          name: signedInCookie.name, value: signedInCookie.value, url: loopbackOrigin,
          secure: scheme === "https", sameSite: "Lax",
        }]);
        await loopback.page.goto(`${loopbackOrigin}/team`);
        await loopback.page.locator("[data-team-member-open]").first().click();
        await waitForText(loopback.page.locator("[data-team-dialog=member] [data-passkey-unavailable]"), translate(locale, "team.passkey.unavailableAt", { address: origin }));
        expect(await loopback.page.locator("[data-team-add-passkey]").count()).toBe(0);
        await loopback.page.screenshot({ path: path.join(SHOTS, `profile-localhost-${scheme}-${width}-${locale}.png`) });
        await loopback.context.close();
      }
    }

    const unsupported = await pageFor(browser, "en", 390);
    await unsupported.context.addInitScript(() => { Object.defineProperty(window, "PublicKeyCredential", { configurable: true, value: undefined }); });
    await unsupported.page.goto(`${origin}/sign-in`);
    await waitForText(unsupported.page.locator("[data-passkey-unavailable]"), translate("en", "team.passkey.browserUnsupportedSignIn"));
    expect(await unsupported.page.locator('[data-sign-in-method="passkey"]').count()).toBe(0);
    await unsupported.context.addCookies([{ name: signedInCookie.name, value: signedInCookie.value, url: origin, secure: true, sameSite: "Lax" }]);
    await unsupported.page.goto(`${origin}/team`);
    await unsupported.page.locator("[data-team-member-open]").first().click();
    await waitForText(unsupported.page.locator("[data-team-dialog=member] [data-passkey-unavailable]"), translate("en", "team.passkey.browserUnsupportedRegistration"));
    expect(await unsupported.page.locator("[data-team-add-passkey]").count()).toBe(0);
    await unsupported.context.close();
  } finally {
    await browser?.close();
    if (child.pid && child.exitCode === null) child.kill("SIGTERM");
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  }
}, 180_000);
