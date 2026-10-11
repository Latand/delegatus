/*
 * Prototype harness for docs/design/role-avatars.md. It adds no driver to the
 * product: it patches a `git archive` export of the repository so FeedItem
 * draws a role avatar, adds a `role-avatars` case to the existing conversation
 * fixture, and renders that case through the existing evidence harness
 * (serveEvidenceFixture / openFixture in issue1695BrowserHarness.ts).
 *
 *   git archive HEAD | tar -x -C "$TMPDIR/ra/export" && (cd "$TMPDIR/ra/export" && bun install --frozen-lockfile)
 *   CHROME_BIN=<chrome with a short TMPDIR> bun docs/design/role-avatars/render-frames.ts "$TMPDIR/ra/export"
 *
 * Writes svg/1-costume/<role>.svg beside this file, and frames/ (ignored by
 * git: a browser render carries no generator provenance, so the publication
 * gate refuses committed rasters) with geometry.json. Prototype source only:
 * delete this directory's .ts/.tsx files once the operator has decided.
 */
import fs from "node:fs";
import path from "node:path";

import { AVATAR_ROLES, costumeSvg } from "./roleAvatarCostumes";

const here = import.meta.dir;
const exportDir = path.resolve(process.argv[2] ?? "");
if (!fs.existsSync(path.join(exportDir, "src/components/feed/FeedItem.tsx"))) throw new Error("usage: render-frames.ts <export dir>");
const outDir = path.join(here, "frames");
fs.mkdirSync(outDir, { recursive: true });

/* 1. The costume drawings as files. */
const svgDir = path.join(here, "svg/1-costume");
fs.mkdirSync(svgDir, { recursive: true });
for (const role of [...AVATAR_ROLES, "neutral"] as const) fs.writeFileSync(path.join(svgDir, `${role}.svg`), `${costumeSvg(role)}\n`);

/* 2. The prototype sources into the export. */
const feed = path.join(exportDir, "src/components/feed");
for (const name of ["roleAvatarCostumes.ts", "roleAvatarProto.tsx", "roleAvatarsEvidence.tsx"]) fs.copyFileSync(path.join(here, name), path.join(feed, name));

/* Every run patches the file as exported, kept beside it on the first run. */
function patch(file: string, edits: [string, string][]) {
  if (!fs.existsSync(`${file}.orig`)) fs.copyFileSync(file, `${file}.orig`);
  let source = fs.readFileSync(`${file}.orig`, "utf8");
  for (const [from, to] of edits) {
    const count = source.split(from).length - 1;
    if (count !== 1) throw new Error(`${path.basename(file)}: expected one match, found ${count}: ${from.slice(0, 80)}`);
    source = source.replace(from, to);
  }
  fs.writeFileSync(file, source);
}

/* 3. FeedItem: the agent's answers and the internal cards draw the avatar while
   a RoleAvatarScope is present; without one every row is today's. */
patch(path.join(feed, "FeedItem.tsx"), [
  [`import { quoteHead } from "../conversation/deputyPlacement";`,
    `import { quoteHead } from "../conversation/deputyPlacement";\nimport { RoleAvatar, isAvatarRole, useRoleAvatarScope } from "./roleAvatarProto";\nimport { roleNameById } from "@/components/builderCopy";`],
  [`  const { t } = useLocale();\n  const isMobile = useIsMobile();`,
    `  const { t } = useLocale();\n  const proto = useRoleAvatarScope();\n  const protoRole = proto?.role ?? null;\n  const protoName = protoRole ? (protoRole === "neutral" ? t("roleFrame.neutral") : roleNameById(t, protoRole)) : null;\n  const isMobile = useIsMobile();`],
  [`{deputyInk ? <DeputyMark engine={item.engine} /> : avatarIcon("h-4 w-4 shrink-0 text-secondary")}`,
    `{proto && protoRole ? <RoleAvatar variant={proto.variant} role={protoRole} size={20} /> : deputyInk ? <DeputyMark engine={item.engine} /> : avatarIcon("h-4 w-4 shrink-0 text-secondary")}`],
  [`{deputyInk ? t("deputy.participant") : ENGINE_LABEL[item.engine]}</span>`,
    `{protoName ? protoName : deputyInk ? t("deputy.participant") : ENGINE_LABEL[item.engine]}</span>{protoName ? <span className="shrink-0">· {ENGINE_LABEL[item.engine]}</span> : null}`],
  [`        {deputyInk ? <DeputyMark engine={item.engine} size={26} className="mt-1" /> : (`,
    `        {proto && protoRole ? <RoleAvatar variant={proto.variant} role={protoRole} size={26} className="mt-1" /> : deputyInk ? <DeputyMark engine={item.engine} size={26} className="mt-1" /> : (`],
  [`            {hhmm(item.ts) ? <span className="text-label tabular-nums text-muted">{hhmm(item.ts)}</span> : null}\n            <span className="ml-auto`,
    `            {protoName ? <><span data-rax-speaker className="text-label font-semibold text-secondary">{protoName}</span><span className="text-label text-muted">· {ENGINE_LABEL[item.engine]} ·</span></> : null}\n            {hhmm(item.ts) ? <span className="text-label tabular-nums text-muted">{hhmm(item.ts)}</span> : null}\n            <span className="ml-auto`],
  [`<span className={\`flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg \${item.voiceRelay ? "bg-info-soft text-info" : "bg-accent-soft text-accent"}\`}>`,
    `<span className={\`flex h-6.5 w-6.5 shrink-0 items-center justify-center rounded-lg \${item.voiceRelay ? "bg-info-soft text-info" : "bg-accent-soft text-accent"}\`} style={proto && item.internal && isAvatarRole(item.peer) ? { background: "transparent", ["--avatar-ring" as string]: "var(--color-accent-soft)" } : undefined}>`],
  [`{item.internal ? <DelegatusMark size={20} /> : <Mail className="h-3.5 w-3.5" aria-hidden />}`,
    `{item.internal ? (proto && isAvatarRole(item.peer) ? <RoleAvatar variant={proto.variant} role={item.peer} size={26} /> : <DelegatusMark size={20} />) : <Mail className="h-3.5 w-3.5" aria-hidden />}`],
  [` · \${agentRoleLabel(item.peer, t)}\``,
    ` · \${proto && isAvatarRole(item.peer) ? roleNameById(t, item.peer) : agentRoleLabel(item.peer, t)}\``],
]);

/* 4. The fixture's dispatcher mounts the new case. */
patch(path.join(exportDir, "src/components/conversation/conversationWindowEvidence.fixture.tsx"), [
  [`if (root && requested === "lifecycle") mountLifecycle(root);`,
    `if (root && (requested as string) === "role-avatars") createRoot(root).render(<RoleAvatarsEvidence variant={Number(params.get("avatar") ?? 1) as 1 | 2 | 3} />);\nelse if (root && requested === "lifecycle") mountLifecycle(root);`],
  [`import { LogFeed } from "@/components/LogFeed";`,
    `import { LogFeed } from "@/components/LogFeed";\nimport { RoleAvatarsEvidence } from "@/components/feed/roleAvatarsEvidence";`],
]);

/* 5. Render: three variants × desktop and phone × light and dark, Ukrainian,
   plus a 2× close-up of each variant's size sheet. */
process.chdir(exportDir);
const { chromium } = await import(path.join(exportDir, "node_modules/playwright-core/index.mjs"));
const { openFixture, serveEvidenceFixture } = await import(path.join(exportDir, "src/components/kanban/issue1695BrowserHarness.ts"));
const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR ?? "/tmp", "rax-"));
const server = await serveEvidenceFixture(scratch, "src/components/conversation/conversationWindowEvidence.fixture.tsx");
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"], ...(process.env.CHROME_BIN ? { executablePath: process.env.CHROME_BIN } : {}) });
const geometry: Record<string, unknown> = {};
try {
  for (const variant of [1, 2, 3] as const) {
    for (const scheme of ["light", "dark"] as const) {
      for (const shape of [
        { name: "desktop-1280", viewport: { width: 1280, height: 900 }, touch: false, scale: 1 },
        { name: "phone-390", viewport: { width: 390, height: 844 }, touch: true, scale: 2 },
      ]) {
        const { context, page, pageErrors } = await openFixture(browser, `${server.base}?case=role-avatars&avatar=${variant}&lang=uk`, shape.viewport, scheme, "uk", "reduce", shape.touch, shape.scale);
        await page.waitForSelector("[data-evidence-case='role-avatars'] [data-rax-pane='builder'] [data-role-avatar]");
        await page.evaluate(() => document.fonts.ready);
        await page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0));
        const key = `v${variant}-${shape.name}-${scheme}`;
        geometry[key] = await page.evaluate(() => {
          const rect = (element: Element) => { const box = element.getBoundingClientRect(); return [Math.round(box.width * 10) / 10, Math.round(box.height * 10) / 10]; };
          const panes = [...document.querySelectorAll("[data-rax-pane]")];
          return {
            sideways: document.documentElement.scrollWidth - window.innerWidth,
            sheetAvatars: [...document.querySelectorAll(".rax-sheet [data-role-avatar]")].length,
            feedAvatars: Object.fromEntries(panes.map((pane) => [pane.getAttribute("data-rax-pane"),
              [...pane.querySelectorAll("[data-role-avatar]")].map((element) => `${element.getAttribute("data-role-avatar")}:${rect(element).join("x")}`)])),
            /* A header row's avatar must sit inside the row: overflow in px. */
            headerOverflow: Math.max(0, ...[...document.querySelectorAll("[data-mobile-message-header]")].map((row) => {
              const box = row.getBoundingClientRect();
              return Math.max(0, ...[...row.querySelectorAll("[data-role-avatar]")].map((avatar) => {
                const inner = avatar.getBoundingClientRect();
                return Math.max(box.top - inner.top, inner.bottom - box.bottom, inner.right - box.right);
              }));
            })),
          };
        });
        if (pageErrors.length) throw new Error(`${key}: ${pageErrors.join("; ")}`);
        await page.screenshot({ path: path.join(outDir, `variant-${variant}-${shape.name}-${scheme}-uk.png`), fullPage: true, scale: "device" });
        await context.close();
      }
      const { context, page } = await openFixture(browser, `${server.base}?case=role-avatars&avatar=${variant}&lang=uk`, { width: 1280, height: 900 }, scheme, "uk", "reduce", false, 2);
      await page.waitForSelector(".rax-sheet [data-role-avatar]");
      await page.waitForFunction(() => [...document.images].every((image) => image.complete && image.naturalWidth > 0));
      await page.locator(".rax-sheet").screenshot({ path: path.join(outDir, `variant-${variant}-sheet-2x-${scheme}-uk.png`) });
      await context.close();
    }
  }
} finally {
  await browser.close();
  server.stop();
  fs.rmSync(scratch, { recursive: true, force: true });
}
fs.writeFileSync(path.join(outDir, "geometry.json"), `${JSON.stringify(geometry, null, 2)}\n`);
console.log(JSON.stringify(geometry, null, 2));
