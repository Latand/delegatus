# Bash parses the same rm wrapper once, with call-local variables. The real
# binary still starts once per admitted call. Other children keep PATH wrappers.
if [ -n "${LLV_DESTRUCTIVE_GUARD_PREVIOUS_BASH_ENV:-}" ] && [ -f "$LLV_DESTRUCTIVE_GUARD_PREVIOUS_BASH_ENV" ]; then
  . "$LLV_DESTRUCTIVE_GUARD_PREVIOUS_BASH_ENV"
fi
rm() {
  # Paths are byte strings. Bytewise parameter trimming avoids repeatedly
  # decoding long multibyte locale paths while walking every ancestor.
  local guard_locale=${LC_ALL-} LC_ALL=C stamp target roots root probe
  # The common one-file call needs no option or operand grammar loop. Keep
  # the same stamp, physical cwd and complete parent-link checks.
  if [[ $# -eq 2 && ${1-} == -f && ${2-} == /* && $PATH == "${LLV_DESTRUCTIVE_GUARD_BOUND_PATH:-}" && -n ${LLV_DESTRUCTIVE_GUARD_RM:-} && ${PWD:-} -ef .
    && -r ${LLV_DESTRUCTIVE_GUARD_FAST_STAMP:-} && -f ${LLV_DESTRUCTIVE_GUARD_POLICY:-} && ! $LLV_DESTRUCTIVE_GUARD_POLICY -nt $LLV_DESTRUCTIVE_GUARD_FAST_STAMP ]]; then
    # Read one extra byte so an appended/corrupt digest cannot use the prefix.
    IFS= read -r -n 65 stamp < "$LLV_DESTRUCTIVE_GUARD_FAST_STAMP" || :
    if [[ -n $stamp && $stamp == "${LLV_DESTRUCTIVE_GUARD_POLICY_DIGEST:-}" ]]; then
      target=$2
      case "$target" in */|*/./*|*/../*|*/.|*/..|*//*) ;; *)
        roots=${LLV_DESTRUCTIVE_GUARD_FAST:-}
        while [[ -n $roots ]]; do
          root=${roots%%:*}
          case "$roots" in *:*) roots=${roots#*:} ;; *) roots= ;; esac
          if [[ $target == "$root/"* ]]; then
            probe=${target%/*}
            while [[ -n $probe && ! -L $probe ]]; do probe=${probe%/*}; done
            if [[ -z $probe ]]; then LC_ALL=$guard_locale "$LLV_DESTRUCTIVE_GUARD_RM" "$@"; return $?; fi
            break
          fi
        done
      esac
    fi
  fi
  LC_ALL=$guard_locale
  local LLV_DESTRUCTIVE_GUARD_SOURCE_DIR=$LLV_DESTRUCTIVE_GUARD_DIR LLV_DESTRUCTIVE_GUARD_COMMAND_MODE=1
  local fast options last_parent arg parent admitted
  # DELEGATUS_RM_BODY
}
