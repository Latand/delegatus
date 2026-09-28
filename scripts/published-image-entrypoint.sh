#!/bin/sh
set -eu

# The published image cannot know the caller's UID or home at build time.
# Supply an NSS record without requiring root or editing /etc/passwd.
case ${HOME:-} in
  /*) ;;
  *) echo 'HOME must be an absolute path' >&2; exit 1 ;;
esac
case $HOME in
  *:*) echo 'HOME cannot contain a colon' >&2; exit 1 ;;
esac

uid=$(id -u)
gid=$(id -g)
identity_dir=$(mktemp -d /tmp/delegatus-identity.XXXXXX)
awk -F: -v uid="$uid" '$3 != uid' /etc/passwd > "$identity_dir/passwd"
printf 'delegatus-runtime:x:%s:%s::%s:/bin/sh\n' "$uid" "$gid" "$HOME" >> "$identity_dir/passwd"
cp /etc/group "$identity_dir/group"
if ! awk -F: -v gid="$gid" '$3 == gid { found = 1 } END { exit !found }' "$identity_dir/group"; then
  printf 'delegatus-runtime:x:%s:\n' "$gid" >> "$identity_dir/group"
fi

export NSS_WRAPPER_PASSWD="$identity_dir/passwd"
export NSS_WRAPPER_GROUP="$identity_dir/group"
export LD_PRELOAD="/usr/local/lib/libnss_wrapper.so${LD_PRELOAD:+:$LD_PRELOAD}"
exec "$@"
