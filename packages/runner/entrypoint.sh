#!/bin/sh
set -eu

agent_directory=${PI_CLOUD_HOSTED_AGENT_ROOTS:-/var/lib/pi-cloud/agent}
if [ -e "$agent_directory/auth.json" ] || [ -e "$agent_directory/sessions" ]; then
  echo "Hosted Pi resources must not contain auth.json or native sessions; use a sanitized resource-only directory." >&2
  exit 1
fi
if [ -n "$(find "$agent_directory" -type l -print -quit)" ]; then
  echo "Hosted Pi resources must not contain symbolic links." >&2
  exit 1
fi
if [ -n "$(find "$agent_directory" -type d ! -perm -0005 -print -quit)" ] \
  || [ -n "$(find "$agent_directory" -type f ! -perm -0004 -print -quit)" ]; then
  echo "Hosted Pi resources must be readable and directories traversable by isolated workspace UIDs." >&2
  exit 1
fi

# Deny untrusted workspace UIDs access to host/private networks while retaining public provider egress.
iptables -A OUTPUT -o lo -j ACCEPT
for network in 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16; do
  iptables -A OUTPUT -m owner ! --uid-owner 0 -d "$network" -j REJECT
done
if [ -s /proc/net/if_inet6 ]; then
  ip6tables -A OUTPUT -o lo -j ACCEPT
  for network in ::ffff:0:0/96 fc00::/7 fec0::/10 fe80::/10; do
    ip6tables -A OUTPUT -m owner ! --uid-owner 0 -d "$network" -j REJECT
  done
fi

if [ "$#" -gt 0 ]; then
  exec "$@"
fi
if [ -z "${PI_CLOUD_HOSTED_DISPATCHER_TOKEN:-}" ]; then
  exec node packages/runner/dist/runner.js
fi
trap 'kill -TERM "$child" 2>/dev/null || true; wait "$child" || true; exit 0' TERM INT
while :; do
  node packages/runner/dist/runner.js & child=$!
  wait "$child" || exit $?
  sleep 1
done
