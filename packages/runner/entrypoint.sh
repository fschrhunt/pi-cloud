#!/bin/sh
set -eu

# Deny untrusted workspace UIDs access to host/private networks while retaining public provider egress.
iptables -A OUTPUT -o lo -j ACCEPT
for network in 10.0.0.0/8 100.64.0.0/10 169.254.0.0/16 172.16.0.0/12 192.168.0.0/16; do
  iptables -A OUTPUT -m owner ! --uid-owner 0 -d "$network" -j REJECT
done
ip6tables -A OUTPUT -o lo -j ACCEPT
for network in fc00::/7 fe80::/10; do
  ip6tables -A OUTPUT -m owner ! --uid-owner 0 -d "$network" -j REJECT
done

if [ -z "${PI_CLOUD_HOSTED_DISPATCHER_TOKEN:-}" ]; then
  exec node packages/runner/dist/runner.js
fi
trap 'kill -TERM "$child" 2>/dev/null || true; wait "$child" || true; exit 0' TERM INT
while :; do
  node packages/runner/dist/runner.js & child=$!
  wait "$child" || exit $?
  sleep 1
done
