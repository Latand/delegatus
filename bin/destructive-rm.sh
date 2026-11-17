#!/bin/sh
# A tiny admit-only launcher for the unchanged launch PATH. Everything else
# uses the generic wrapper's real-binary search and shared policy program.
delegatus_guard_rm() {
set -f
stamp=
if [ -r "${LLV_DESTRUCTIVE_GUARD_FAST_STAMP:-}" ]; then IFS= read -r stamp < "$LLV_DESTRUCTIVE_GUARD_FAST_STAMP" || :; fi
if [ -n "$stamp" ] && [ "$stamp" = "${LLV_DESTRUCTIVE_GUARD_POLICY_DIGEST:-}" ] && [ "$PATH" = "${LLV_DESTRUCTIVE_GUARD_BOUND_PATH:-}" ] && [ -n "${LLV_DESTRUCTIVE_GUARD_RM:-}" ] && [ -f "${LLV_DESTRUCTIVE_GUARD_POLICY:-}" ] && ! [ "$LLV_DESTRUCTIVE_GUARD_POLICY" -nt "${LLV_DESTRUCTIVE_GUARD_FAST_STAMP:-/dev/null}" ]; then
  fast=yes options=yes last_parent=
  for arg do
    if [ "$options" = yes ]; then
      case "$arg" in --) options=no; continue ;; -f|-r|-R|-rf|-fr|-Rf|-fR|-rRf|--force|--recursive) continue ;; -*) fast=no; break ;; esac
    fi
    case "$arg" in */*|.|..) ;; *) [ "$last_parent" = "$PWD" ] && continue ;; esac
    case "$arg" in /*) target=$arg ;; *) target=$PWD/$arg ;; esac
    case "$target" in */|*/./*|*/../*|*/.|*/..|*//*) fast=no; break ;; esac
    parent=${target%/*}
    [ "$parent" = "$last_parent" ] && continue
    admitted=no old_ifs=$IFS
    IFS=:
    for root in ${LLV_DESTRUCTIVE_GUARD_FAST:-}; do
      case "$target" in "$root"/*)
        probe=$parent admitted=yes
        while [ -n "$probe" ]; do
          if [ -L "$probe" ]; then admitted=no; break; fi
          [ "$probe" = "$root" ] && break
          probe=${probe%/*}
        done
        break ;;
      esac
    done
    IFS=$old_ifs
    if [ "$admitted" = no ]; then fast=no; break; fi
    last_parent=$parent
  done
  if [ "$fast" = yes ] && ! [ "$LLV_DESTRUCTIVE_GUARD_RM" -ef "$0" ]; then
    if [ "${LLV_DESTRUCTIVE_GUARD_COMMAND_MODE:-}" = 1 ]; then "$LLV_DESTRUCTIVE_GUARD_RM" "$@"; return $?; fi
    exec "$LLV_DESTRUCTIVE_GUARD_RM" "$@"
  fi
fi
if [ "${LLV_DESTRUCTIVE_GUARD_COMMAND_MODE:-}" = 1 ]; then "${LLV_DESTRUCTIVE_GUARD_SOURCE_DIR:-${0%/*}}/slow-rm" "$@"; return $?; fi
exec "${LLV_DESTRUCTIVE_GUARD_SOURCE_DIR:-${0%/*}}/slow-rm" "$@"
}
if [ "${LLV_DESTRUCTIVE_GUARD_DEFINE_ONLY:-}" != 1 ]; then delegatus_guard_rm "$@"; fi
