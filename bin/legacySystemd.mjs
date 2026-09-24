/* Docker is the only install (docs/docker.md). A machine set up before that
   may still carry the retired systemd user units; the CLI names them once at
   start and says how to move off them, and changes nothing on its own. */

import { lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const LEGACY_SYSTEMD_UNITS = ["agent-log-viewer.service", "agent-log-viewer-legacy-tmux.service"];

export const DOCKER_INSTALL_GUIDE = "https://github.com/Latand/delegatus/blob/main/docs/docker.md";

const TMUX_UNIT = "agent-log-viewer-legacy-tmux.service";

/** The retired unit files present in the user's systemd unit directory. A
    dangling symlink still counts: it is the same leftover to remove. */
export function findLegacySystemdUnits(options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform !== "linux") return [];
  const env = options.env ?? process.env;
  const configRoot = env.XDG_CONFIG_HOME?.trim() || join(options.home ?? homedir(), ".config");
  const unitDir = join(configRoot, "systemd", "user");
  const present = options.present ?? ((filename) => {
    try {
      lstatSync(filename);
      return true;
    } catch {
      return false;
    }
  });
  return LEGACY_SYSTEMD_UNITS
    .map((name) => ({ name, path: join(unitDir, name) }))
    .filter((unit) => present(unit.path));
}

/** The one migration message, or null when no retired unit is present. */
export function legacySystemdNotice(units, lang = "en") {
  if (units.length === 0) return null;
  const names = units.map((unit) => unit.name).join(" ");
  const paths = units.map((unit) => unit.path).join(" ");
  const hostsTmux = units.some((unit) => unit.name === TMUX_UNIT);
  const commands = [
    `  systemctl --user disable --now ${names}`,
    `  rm ${paths}`,
    "  systemctl --user daemon-reload",
  ].join("\n");
  if (lang === "uk") {
    return [
      "Встановлення Delegatus через systemd більше не підтримується: єдиний спосіб встановлення — Docker.",
      `На цій машині лишилися старі юніти: ${paths}`,
      ...(hostsTmux ? [`Зупинка ${TMUX_UNIT} закриває всі tmux-сесії, які він тримає; спершу завершіть агентів у цих панелях.`] : []),
      "Зупиніть і видаліть їх:",
      commands,
      `Потім встановіть Delegatus через Docker: ${DOCKER_INSTALL_GUIDE}`,
    ].join("\n");
  }
  return [
    "The systemd install of Delegatus is retired: Docker is the only install.",
    `This machine still has the legacy units: ${paths}`,
    ...(hostsTmux ? [`Stopping ${TMUX_UNIT} ends every tmux session it hosts; finish the agents in those panes first.`] : []),
    "Stop and remove them:",
    commands,
    `Then install Delegatus with Docker: ${DOCKER_INSTALL_GUIDE}`,
  ].join("\n");
}
