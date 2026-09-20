import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { serveEvidenceFixture } from "../../../src/components/kanban/issue1695BrowserHarness";
/** Called by the existing browser driver, against an exported candidate. */
export async function gradeRendered(workspace: string, output: string) {
    fs.mkdirSync(output, { recursive: true });
    const entry = path.join(output, "entry.tsx");
    const settings = process.env.ROLE_EVAL_UI_INPUT ? JSON.parse(fs.readFileSync(process.env.ROLE_EVAL_UI_INPUT, "utf8")) : { count: 12 };
    const count = settings.count;
    if (!Number.isInteger(count) || count < 2 || count > 40)
        throw new Error("invalid UI vector");
    const target = String(count - 1);
    fs.writeFileSync(entry, `import React, {useState} from ${JSON.stringify(path.resolve("node_modules/react"))};
import {createRoot} from ${JSON.stringify(path.resolve("node_modules/react-dom/client"))};
import {ErrorRow} from ${JSON.stringify(path.join(workspace, "case/ErrorRow.tsx"))};
const uk=new URLSearchParams(location.search).get("lang")==="uk";
const labels=uk?{action:"Закрити",retry:"Повторити",error:"Дію відхилено. Спробуйте ще раз."}:{action:"Close",retry:"Retry",error:"Action rejected. Please retry."};
const initial=Array.from({length:${count}},(_,i)=>({id:String(i),title:uk?"Рядок "+i:"Row "+i}));
window.probe={calls:[], resolve:null,reject:null,reorder:null};
function App(){const [rows,setRows]=useState(initial);window.probe.reorder=()=>setRows(old=>[...old].reverse());return <ErrorRow rows={rows} labels={labels} perform={id=>{window.probe.calls.push(id);return new Promise((resolve,reject)=>{window.probe.resolve=resolve;window.probe.reject=reject;});}}/>;}
createRoot(document.getElementById("root")).render(<App/>);`);
    const dependencyLink = path.join(output, "node_modules");
    const candidateLink=path.join(workspace,"node_modules");
    const suppliedDependencies=fs.existsSync(candidateLink);
    if(!suppliedDependencies)fs.symlinkSync(path.resolve("node_modules"),candidateLink,"dir");
    fs.symlinkSync(path.resolve("node_modules"), dependencyLink, "dir");
    let server: Awaited<ReturnType<typeof serveEvidenceFixture>>;
    try {
        server = await serveEvidenceFixture(output, entry);
    }
    finally {
        fs.unlinkSync(dependencyLink);
        if(!suppliedDependencies)fs.unlinkSync(candidateLink);
    }
    const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_BIN, args: ["--no-sandbox"] });
    const results: unknown[] = [];
    try {
        for (const [width, height] of [[1440, 900], [390, 844], [390, 600]])
            for (const lang of ["en", "uk"])
                for (const theme of ["light", "dark"] as const) {
                    const context = await browser.newContext({ viewport: { width, height }, hasTouch: true, colorScheme: theme });
                    try {
                        await context.route("**/*", route => new URL(route.request().url()).origin === new URL(server.base).origin ? route.continue() : route.abort());
                        const page = await context.newPage();
                        const errors: string[] = [];
                        page.on("pageerror", e => errors.push(e.message));
                        await page.goto(`${server.base}?lang=${lang}`);
                        await page.evaluate((dark) => document.documentElement.classList.toggle("dark", dark), theme === "dark");
                        const prefix = `${width}x${height}-${lang}-${theme}`;
                        const row = page.locator('[data-row="' + target + '"]');
                        await row.scrollIntoViewIfNeeded();
                        const contrast = await row.locator("[data-mobile2-swipe-card] > div").evaluate(element => {
                            const style = getComputedStyle(element);
                            const luminance = (color: string) => { const rgb = (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number).map(v => v / 255).map(v => v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return .2126 * rgb[0] + .7152 * rgb[1] + .0722 * rgb[2]; };
                            const a = luminance(style.color), b = luminance(style.backgroundColor);
                            return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
                        });
                        assert.ok(contrast >= 4.5, "row text contrast below 4.5");
                        await page.screenshot({ path: path.join(output, `${prefix}-before.png`) });
                        const action = row.locator(`button[aria-label="${lang === "uk" ? "Закрити" : "Close"} ${target}"]`);
                        if (width === 390) {
                            const box = await row.locator("[data-mobile2-swipe-card]").boundingBox();
                            assert.ok(box);
                            const cdp = await context.newCDPSession(page);
                            await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: box.x + box.width - 15, y: box.y + 25 }] });
                            for (const dx of [25, 50, 85]) {
                                await page.waitForTimeout(35);
                                await cdp.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: box.x + box.width - 15 - dx, y: box.y + 25 }] });
                            }
                            await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
                            await row.locator('[data-mobile2-swipe-open="true"]').waitFor();
                            await page.waitForTimeout(500);
                            const tray = row.locator('[data-mobile2-swipe-action="act"]');
                            await tray.focus();
                            await tray.tap();
                        }
                        else {
                            await action.focus();
                            await page.keyboard.press("Enter");
                        }
                        await page.waitForFunction(() => (window as any).probe.calls.length > 0, undefined, { timeout: 5000 });
                        assert.deepEqual(await page.evaluate(() => (window as any).probe.calls), [target], prefix + ": one activation");
                        if (await action.count()) {
                            assert.equal(await action.isDisabled(), true, "pending action must be disabled");
                            await row.locator('[data-mobile2-swipe-action="act"]').evaluate(button => (button as HTMLButtonElement).click());
                            assert.deepEqual(await page.evaluate(() => (window as any).probe.calls), [target], "pending tray activation duplicated dispatch");
                        }
                        await page.evaluate(() => { (window as any).probe.reorder(); (window as any).probe.reject(new Error("refused")); });
                        await row.locator('[role="alert"]').waitFor({ timeout: 5000 });
                        const retry = row.locator(`button[aria-label="${lang === "uk" ? "Повторити" : "Retry"} ${target}"]`);
                        await retry.scrollIntoViewIfNeeded();
                        const geometry = await retry.evaluate((button) => {
                            const b = button.getBoundingClientRect();
                            const alert = button.closest('[role="alert"]')!.getBoundingClientRect();
                            const hit = document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2);
                            return { x: b.x, y: b.y, width: b.width, height: b.height, bottom: b.bottom, alertBottom: alert.bottom, hit: !!hit && button.contains(hit), overflow: document.documentElement.scrollWidth - innerWidth };
                        });
                        assert.ok(geometry.width >= 44 && geometry.height >= 44 && geometry.y >= 0 && geometry.bottom <= height + 1 && geometry.x >= 0 && geometry.x + geometry.width <= width + 1, "retry target visible and >=44px");
                        assert.ok(geometry.bottom <= geometry.alertBottom + 1 && geometry.hit && geometry.overflow <= 1, "retry is clipped, overlapped, or overflows");
                        await page.screenshot({ path: path.join(output, `${prefix}-rejected.png`) });
                        if (width === 390)
                            await retry.tap();
                        else {
                            await retry.focus();
                            await page.keyboard.press("Enter");
                        }
                        await page.waitForFunction(() => (window as any).probe.calls.length === 2);
                        await page.evaluate(() => (window as any).probe.resolve());
                        await page.waitForFunction(id => !document.querySelector('[data-row="' + id + '"]'), target);
                        assert.deepEqual(await page.evaluate(() => (window as any).probe.calls), [target, target]);
                        assert.deepEqual(errors, []);
                        await page.screenshot({ path: path.join(output, `${prefix}-retried.png`) });
                        results.push({ width, height, lang, theme, geometry });
                    }
                    finally {
                        await context.close();
                    }
                }
        fs.writeFileSync(path.join(output, "geometry.json"), JSON.stringify({ browser: browser.version(), results }, null, 2));
    }
    finally {
        await browser.close();
        server.stop();
    }
}
