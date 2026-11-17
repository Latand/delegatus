# Bash parses the same rm wrapper once, with call-local variables. The real
# binary still starts once per admitted call. Other children keep PATH wrappers.
if [ -n "${LLV_DESTRUCTIVE_GUARD_PREVIOUS_BASH_ENV:-}" ] && [ -f "$LLV_DESTRUCTIVE_GUARD_PREVIOUS_BASH_ENV" ]; then
  . "$LLV_DESTRUCTIVE_GUARD_PREVIOUS_BASH_ENV"
fi
LLV_DESTRUCTIVE_GUARD_DEFINE_ONLY=1
. "$LLV_DESTRUCTIVE_GUARD_DIR/rm"
unset LLV_DESTRUCTIVE_GUARD_DEFINE_ONLY
rm() {
  local LLV_DESTRUCTIVE_GUARD_SOURCE_DIR=$LLV_DESTRUCTIVE_GUARD_DIR LLV_DESTRUCTIVE_GUARD_COMMAND_MODE=1
  local stamp fast options last_parent arg target parent admitted roots root probe
  delegatus_guard_rm "$@"
}
