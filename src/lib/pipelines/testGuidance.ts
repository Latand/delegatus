import fs from "node:fs";
import path from "node:path";

/** The Viewer runs from its install or its standalone server directory.
    Resolve there, never relative to the project's worktree. Keep filesystem
    imports out of the renderer shared by browser previews. */
export function resolveStageTestGuidance(toolingCwd = process.cwd()): string {
  let directory = path.resolve(toolingCwd);
  for (;;) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(directory, "package.json"), "utf8"));
      if (manifest.name === "delegatus-cli" && fs.existsSync(path.join(directory, "bin", "cli.mjs"))) {
        const scripts = path.join(directory, "scripts");
        for (const file of ["gate-slot.sh", "owned-runner.ts", "cpu-admission.ts"]) {
          const candidate = path.join(scripts, file);
          if (!fs.statSync(candidate).isFile()) throw new Error("missing gate tooling");
          fs.accessSync(candidate, fs.constants.R_OK);
        }
        const wrapper = fs.realpathSync(path.join(scripts, "gate-slot.sh"));
        const quoted = `'${wrapper.replaceAll("'", "'\\''")}'`;
        return `Run test files by explicit path using the project's test command from its instruction files or package scripts: bash ${quoted} <project-test-command> <file>, with the runner's file-selection syntax and isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR. Run heavy checks one at a time through this wrapper. The owned runner ends detached descendants on deadline or cancellation; never bypass it for lifecycle tests.`;
      }
    } catch {
      // An absent or incomplete install still produces a usable brief below.
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return "Gate wrapper unavailable: installed Delegatus gate tooling could not be resolved. Run test files by explicit path using the project's test command from its instruction files or package scripts, with the runner's file-selection syntax and isolated HOME, XDG_CONFIG_HOME, TMPDIR and LLV_STATE_DIR. Run heavy checks one at a time directly and report that shared gate containment was unavailable; keep subprocess deadlines and cleanup required by the project.";
}
