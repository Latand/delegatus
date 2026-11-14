import fs from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import path from "node:path";

export const KEEP_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64");
export const KEEP_TEXT = "# Fixture report\n";

/** Real consumer layouts, with only the parent of nested worktrees recorded. */
export function localFileKeepFixture(base: string) {
  const home = path.join(base, "fixture-home");
  const state = path.join(home, ".config/agent-log-viewer/state");
  const project = path.join(home, "project");
  const codex = path.join(home, ".codex/worktrees/fixture/repo");
  const sibling = path.join(home, ".agents/tools/repo-pipeline-fixture");
  const evidence = path.join(state, "evidence");
  const external = path.join(base, "evidence-root");
  const scratch = path.join(state, "scratch/llv-stage-fixture/tmp");
  fs.mkdirSync(path.dirname(codex), { recursive: true });
  execFileSync("git", ["init", "--quiet", "--initial-branch=fixture", project]);
  execFileSync("git", ["-C", project, "-c", "user.name=Fixture", "-c", "user.email=fixture", "commit", "--quiet", "--allow-empty", "-m", "Fixture root"]);
  execFileSync("git", ["-C", project, "worktree", "add", "--quiet", "--detach", codex]);
  const write = (file: string, bytes: string | Buffer) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, bytes);
    return file;
  };
  write(path.join(state, "project-catalog.json"), JSON.stringify({ files: Object.fromEntries(
    [project, codex, sibling].map((cwd, index) => [`fixture-${index}`, { cwd, projectRoot: cwd }]),
  ) }));
  const checkouts = [project, ...[".worktrees/wt-a", ".claude/worktrees/wt-b", "worktrees/wt-c"].map(dir => path.join(project, dir)), codex, sibling];
  const images = checkouts.map(dir => write(path.join(dir, "shots/render.png"), KEEP_PNG));
  const texts = checkouts.map(dir => write(path.join(dir, "reports/report.md"), KEEP_TEXT));
  for (const dir of [project, path.join(project, ".worktrees/wt-a")]) {
    images.push(write(path.join(dir, ".artifacts/cap/frame.png"), KEEP_PNG));
    texts.push(write(path.join(dir, ".artifacts/pipeline-stage-inputs/private/previous-output.md"), KEEP_TEXT));
  }
  for (const file of [path.join(scratch, "out/frame.png"), path.join(scratch, ".artifacts/cap/frame.png"),
    path.join(evidence, "lane/frame-01.png"), path.join(evidence, "attempt-temp/fixture/files/.artifacts/cap/frame.png"),
    path.join(external, "lane/after.png")]) images.push(write(file, KEEP_PNG));
  texts.push(write(path.join(scratch, "report.md"), KEEP_TEXT));
  const frameDirectory = path.join(project, ".worktrees/wt-a/reports");
  write(path.join(frameDirectory, "index.html"), "<h1>Fixture report</h1>");
  write(path.join(frameDirectory, "style.css"), "h1 { color: teal }");
  const deletedProject = write(path.join(project, ".worktrees/wt-a/shots/gone.png"), KEEP_PNG);
  const temp = path.join(base, "temp");
  const deletedTemp = write(path.join(temp, "claude-fixture/encoded-cwd/session/scratchpad/gone.png"), KEEP_PNG);
  return { home, state, evidence, external, codex, images, texts, frameDirectory, deletedProject, deletedTemp, temp };
}

/** The legacy writer's persisted format has no resolved-source admission proof. */
export function legacyReportPictureFixture(project: string, state: string, hidden = ".private-picture.png") {
  const source = path.join(project, hidden);
  const alias = path.join(project, "public-picture.png");
  const store = path.join(state, "report-media");
  const file = `${createHash("sha256").update(KEEP_PNG).digest("hex")}.png`;
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.writeFileSync(source, KEEP_PNG);
  fs.symlinkSync(source, alias);
  const stat = fs.statSync(alias);
  fs.mkdirSync(store, { recursive: true });
  const copy = path.join(store, file);
  fs.writeFileSync(copy, fs.readFileSync(alias));
  fs.writeFileSync(path.join(store, "index.json"), JSON.stringify([
    { path: alias, file, bytes: stat.size, mtimeMs: stat.mtimeMs, at: 1000, project: null },
  ]));
  fs.unlinkSync(alias);
  return { source, alias, copy };
}
