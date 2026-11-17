#!/bin/sh
# The fast path only admits. Uncertain paths go to the shared policy program.
tool=${0##*/}
tool=${tool#slow-}
dir=${0%/*}
real=
set -f
saved_ifs=$IFS
IFS=:
for entry in $PATH; do
  case "$entry" in ''|"$dir"|*/delegatus/agent-guard/*) continue ;; esac
  candidate=$entry/$tool
  if [ -f "$candidate" ] && [ -x "$candidate" ] && ! [ "$candidate" -ef "$0" ]; then real=$candidate; break; fi
done
IFS=$saved_ifs
if [ -z "$real" ]; then
  for candidate in /usr/bin/"$tool" /bin/"$tool"; do
    if [ -x "$candidate" ] && ! [ "$candidate" -ef "$0" ]; then real=$candidate; break; fi
  done
fi
if [ -z "$real" ]; then printf 'Delegatus: no real %s executable\n' "$tool" >&2; exit 127; fi

check=yes
case "$tool" in
  find)
    check=no
    for arg do [ "$arg" = -delete ] && check=yes; done
    ;;
  rsync)
    check=no
    for arg do case "$arg" in --dele*|--del|--remove-s*) check=yes ;; esac; done
    ;;
esac
if [ "$check" = no ]; then exec "$real" "$@"; fi

fast=yes
stamp=
if [ -r "${LLV_DESTRUCTIVE_GUARD_FAST_STAMP:-}" ]; then IFS= read -r stamp < "$LLV_DESTRUCTIVE_GUARD_FAST_STAMP" || :; fi
if [ -z "$stamp" ] || [ "$stamp" != "${LLV_DESTRUCTIVE_GUARD_POLICY_DIGEST:-}" ] || [ ! -f "${LLV_DESTRUCTIVE_GUARD_POLICY:-}" ] || [ "$LLV_DESTRUCTIVE_GUARD_POLICY" -nt "${LLV_DESTRUCTIVE_GUARD_FAST_STAMP:-/dev/null}" ]; then fast=no; fi
case "$tool" in rm) ;; *) fast=no ;; esac
options=yes
physical_cwd=${PWD:-}
if [ -z "$physical_cwd" ] || [ -L "$physical_cwd" ] || ! [ "$physical_cwd" -ef . ]; then fast=no; fi
last_parent=
for arg do
  [ "$fast" = yes ] || break
  case "$arg" in --no-preserve-root*) fast=no; break ;; esac
  if [ "$options" = yes ]; then
    case "$arg" in
      --) options=no; continue ;;
      -*) continue ;;
    esac
  fi
  case "$arg" in /*) target=$arg ;; *) target=$physical_cwd/$arg ;; esac
  case "$target" in */|*/./*|*/../*|*/.|*/..|*//*) fast=no; break ;; esac
  parent=${target%/*}
  if [ "$parent" = "$last_parent" ]; then continue; fi
  admitted=no
  IFS=:
  for root in ${LLV_DESTRUCTIVE_GUARD_FAST:-}; do
    case "$target" in "$root"/*)
      # Check every parent: a link introduced above a canonical launch root
      # must also retire the lexical fast path.
      probe=$parent
      linked=no
      while [ -n "$probe" ]; do
        if [ -L "$probe" ]; then linked=yes; break; fi
        probe=${probe%/*}
      done
      if [ "$linked" = no ]; then admitted=yes; fi
      break ;;
    esac
  done
  IFS=$saved_ifs
  if [ "$admitted" = no ]; then fast=no; break; fi
  last_parent=$parent
done
if [ "$fast" = yes ]; then exec "$real" "$@"; fi
interpreter=${LLV_DESTRUCTIVE_GUARD_BUN:-}
case "$interpreter" in
  */*) [ -x "$interpreter" ] || interpreter= ;;
  ?*) interpreter=$(command -v "$interpreter" 2>/dev/null) || interpreter= ;;
esac
if [ -z "$interpreter" ]; then interpreter=$(command -v bun || command -v node); fi
"$interpreter" "$dir/destructive-guard.mjs" check "$tool" -- "$@"
status=$?
if [ "$status" -ne 0 ]; then exit "$status"; fi
exec "$real" "$@"
