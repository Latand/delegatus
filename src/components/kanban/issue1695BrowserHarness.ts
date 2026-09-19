import fs from "node:fs";
import path from "node:path";
import tailwind from "@tailwindcss/postcss";
import type { Browser } from "playwright-core";
import postcss from "postcss";

/* The rendered-evidence harness shared by the #1695 browser tests: the real
   Viewer over `issue1695Evidence.fixture.tsx`, bundled for the browser and
   served with the production stylesheet on an ephemeral loopback port. */

export async function serveEvidenceFixture(outDir: string): Promise<{ base: string; stop: () => void }> {
  /* Bundled by a separate `bun build`: inside the `bun test` process,
     `Bun.build` resolves the `@/` alias for some module graphs and not for
     others, and the fixture's graph is one of the others. */
  const bundle = path.join(outDir, "bundle");
  const build = Bun.spawnSync([
    process.execPath, "build", path.resolve("src/components/kanban/issue1695Evidence.fixture.tsx"),
    "--target=browser", `--outdir=${bundle}`, "--define", 'process.env.NODE_ENV="production"', "--define", "process.env={}",
  ], { stdout: "pipe", stderr: "pipe" });
  if (build.exitCode !== 0) throw new Error(`fixture bundle failed: ${build.stderr.toString()}${build.stdout.toString()}`);
  const entry = path.join(bundle, "issue1695Evidence.fixture.js");
  const css = await postcss([tailwind()]).process(fs.readFileSync("src/app/globals.css", "utf8"), { from: path.resolve("src/app/globals.css") });
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch(request) {
      const pathname = new URL(request.url).pathname;
      if (pathname === "/app.js") return new Response(Bun.file(entry), { headers: { "content-type": "text/javascript" } });
      if (pathname === "/style.css") return new Response(css.css, { headers: { "content-type": "text/css" } });
      return new Response(
        '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/style.css"></head>'
        + '<body><div id="root" style="height:100dvh;display:flex;flex-direction:column"></div><script type="module" src="/app.js"></script></body></html>',
        { headers: { "content-type": "text/html" } },
      );
    },
  });
  return { base: `http://127.0.0.1:${server.port}/`, stop: () => server.stop(true) };
}

export async function openFixture(
  browser: Browser,
  url: string,
  viewport: { width: number; height: number },
  scheme: "light" | "dark",
  /* The Viewer reads its language from `llv_lang` in localStorage, so a case
     that gates both languages seeds it before the first render (#1743). */
  lang?: "en" | "uk",
  /* A surface whose resting state is drawn by an animation has a second
     rendering under `prefers-reduced-motion`, and a case that gates the one
     the motion leaves behind has to ask for it (#1798). */
  motion: "no-preference" | "reduce" = "no-preference",
) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: scheme, reducedMotion: motion });
  if (lang) await context.addInitScript(`try { localStorage.setItem("llv_lang", ${JSON.stringify(lang)}); } catch {}`);
  const page = await context.newPage();
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(url);
  return { context, page, pageErrors };
}
