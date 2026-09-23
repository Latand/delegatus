/**
 * `DELEGATUS_X` is the documented spelling of every `LLV_X` variable
 * (docs/design/rename-delegatus.md §5). Internal code keeps reading `LLV_`,
 * so each entry point folds the new prefix into the old one before its module
 * graph loads:
 *
 * - `LLV_X` unset or equal: it takes the value;
 * - `LLV_X` set to something else: `DELEGATUS_X` wins, and one stderr line
 *   names both variables (names only; some values are credentials);
 * - then `DELEGATUS_X` is deleted.
 *
 * The delete is what keeps a spawned agent's sandbox intact: the Viewer writes
 * `LLV_STATE_DIR` into a child's environment on purpose, and an inherited
 * `DELEGATUS_STATE_DIR` would win over it at the child's own entry point.
 * Folded at the root, children only ever see `LLV_`.
 *
 * Importing this module folds `process.env`. It imports nothing, so an entry
 * point can put it first without pulling anything else ahead of its claim.
 */
export const DELEGATUS_ENV_PREFIX = "DELEGATUS_";
export const LEGACY_ENV_PREFIX = "LLV_";

/**
 * Fold `env` in place and return the names of the variables that disagreed.
 *
 * @param {Record<string, string | undefined>} [env]
 * @param {(line: string) => void} [warn]
 * @returns {string[]}
 */
export function foldDelegatusEnvironment(env = process.env, warn = (line) => console.warn(line)) {
  const conflicts = [];
  for (const name of Object.keys(env)) {
    if (!name.startsWith(DELEGATUS_ENV_PREFIX) || name.length === DELEGATUS_ENV_PREFIX.length) continue;
    const value = env[name];
    const legacy = LEGACY_ENV_PREFIX + name.slice(DELEGATUS_ENV_PREFIX.length);
    const held = env[legacy];
    if (value !== undefined) {
      if (held !== undefined && held !== value) {
        conflicts.push(legacy);
        warn(`[delegatus] ${name} and ${legacy} are both set and differ; using ${name}.`);
      }
      env[legacy] = value;
    }
    delete env[name];
  }
  return conflicts;
}

foldDelegatusEnvironment();
