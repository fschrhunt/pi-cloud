#!/bin/sh
set -eu

EXTENSION_VERSION="${PI_CLOUD_VERSION:-0.1.0}"

if [ "$(uname -s)" != "Darwin" ]; then
  printf '%s\n' "Pi Cloud's first client release supports macOS only." >&2
  exit 1
fi

if [ "$(uname -m)" != "arm64" ]; then
  printf '%s\n' "Pi Cloud's first client release supports Apple Silicon Macs only." >&2
  exit 1
fi

if ! command -v pi >/dev/null 2>&1; then
  printf '%s\n' "Pi is required. Install upstream Pi before installing the Pi Cloud extension." >&2
  exit 1
fi

case "$EXTENSION_VERSION" in
  ''|*[!0-9A-Za-z.+-]*)
    printf '%s\n' "PI_CLOUD_VERSION contains unsupported characters." >&2
    exit 1
    ;;
esac

printf 'Installing @pi-cloud/extension@%s through Pi...\n' "$EXTENSION_VERSION"
pi install "npm:@pi-cloud/extension@$EXTENSION_VERSION"
printf '%s\n' "Installed. Run pi --cloud from a Git repository."
