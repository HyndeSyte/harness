#!/bin/bash
# Who may open Cain's panel: writes the nginx map that nginx.conf includes. Ingress
# marks each request with the signed-in Home Assistant user's id (X-Remote-User-Id)
# and drops any copy the browser sent; $cain_owner is 1 only for the owner's id.
# Only a Home Assistant user id (32 lowercase hex) gets in. Anything else, empty
# included, writes a map that admits no one. The id itself is never printed.
#   owner-gate.sh <owner_user_id> <file>
set -u
id="${1-}"
out="${2:?usage: owner-gate.sh <owner_user_id> <file>}"
if [[ $id =~ ^[0123456789abcdef]{32}$ ]]; then
  entry="\"$id\" 1; "
  said="Cain's panel is locked to its owner"
elif [ -z "$id" ]; then
  entry=""
  said="No owner_user_id set in Configuration, so Cain's panel answers Forbidden to everyone"
else
  entry=""
  said="owner_user_id in Configuration isn't a Home Assistant user id, so Cain's panel answers Forbidden to everyone"
fi
printf 'map $http_x_remote_user_id $cain_owner { default 0; %s}\n' "$entry" > "$out.tmp" \
  && mv -f "$out.tmp" "$out" || { echo "owner-gate: could not write $out" >&2; exit 1; }
echo "$said"
