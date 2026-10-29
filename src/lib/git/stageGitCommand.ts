/** Keep receipt hooks in front of an explicitly selected repository hook path.
 * Git's command-line config outranks GIT_CONFIG_COUNT. Preserve the selected
 * path for the guard to forward, and append the guard immediately before the
 * subcommand. All other arguments and stdin pass through unchanged. */
export function stageGitCommandScript(): string {
  return `#!/bin/sh
set -eu
set -f
self=\${0%/*}
rest=
old_ifs=$IFS
IFS=:
for directory in $PATH; do
  case "$directory" in */delegatus/agent-git-hooks/guard-*/*) continue ;; esac
  rest=\${rest:+$rest:}$directory
done
IFS=$old_ifs
PATH=$rest
export PATH
config_override() {
  case "$1" in [cC][oO][rR][eE].[hH][oO][oO][kK][sS][pP][aA][tT][hH]=*)
    variable=\${1#*=}
    case "$variable" in ''|*[!A-Za-z0-9_]*) exit 1 ;; esac
    LLV_AGENT_GIT_ORIGINAL_HOOKS=$(printenv "$variable") || exit 1
    export LLV_AGENT_GIT_ORIGINAL_HOOKS ;;
  esac
}
remaining=$#
while [ "$remaining" -gt 0 ]; do
  argument=$1
  shift
  remaining=$((remaining - 1))
  case "$argument" in
    -c|-C|--git-dir|--work-tree|--namespace|--config-env)
      [ "$remaining" -gt 0 ] || { set -- "$@" "$argument"; break; }
      value=$1
      shift
      remaining=$((remaining - 1))
      if [ "$argument" = -c ]; then
        case "$value" in [cC][oO][rR][eE].[hH][oO][oO][kK][sS][pP][aA][tT][hH]=*)
          LLV_AGENT_GIT_ORIGINAL_HOOKS=\${value#*=}; export LLV_AGENT_GIT_ORIGINAL_HOOKS ;; esac
      fi
      [ "$argument" != --config-env ] || config_override "$value"
      set -- "$@" "$argument" "$value"
      ;;
    --config-env=*) config_override "\${argument#--config-env=}"; set -- "$@" "$argument" ;;
    -*) set -- "$@" "$argument" ;;
    *)
      if [ "\${LLV_AGENT_GIT_ORIGINAL_HOOKS+x}" = x ]; then set -- "$@" -c "core.hooksPath=$self"; fi
      set -- "$@" "$argument"
      # Rotate the remaining subcommand arguments back into their original order.
      while [ "$remaining" -gt 0 ]; do
        argument=$1; shift; set -- "$@" "$argument"
        remaining=$((remaining - 1))
      done
      break ;;
  esac
done
exec git "$@"
`;
}
