#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
repo_dir="$(cd -- "$script_dir/../.." && pwd)"
tauri_dir="$repo_dir/src-tauri"
release_dir="$tauri_dir/target/release"
version="$(sed -n 's/.*"version": "\([^"]*\)".*/\1/p' "$tauri_dir/tauri.conf.json" | head -n 1)"
if [[ ! -x "$release_dir/megavibe" ]]; then
  printf '%s\n' "Build Megavibe first with: npm run tauri -- build" >&2
  exit 1
fi
if [[ ! -d "$release_dir/voice-libs" ]]; then
  printf '%s\n' "Bundled local voice libraries are missing; build the Debian package first." >&2
  exit 1
fi

stage="$(mktemp -d "${TMPDIR:-/tmp}/megavibe-package.XXXXXX")"
bundle="$stage/Megavibe-$version-linux-x86_64"
mkdir -p "$bundle/voice-libs" "$bundle/licenses"
cp "$release_dir/megavibe" "$bundle/megavibe"
cp -a "$release_dir/voice-libs"/lib*.so* "$bundle/voice-libs/"
cp -a "$tauri_dir/licenses/." "$bundle/licenses/"
cat > "$bundle/README.txt" <<'EOF'
Megavibe Linux x86_64

Run ./megavibe to start the desktop app. GTK 3, WebKitGTK 4.1, ALSA, and a
compatible Linux desktop session must be installed on the system.

Voice models are downloaded only when requested in the app and are stored in
the user's private app-data directory. Once downloaded, voice planning works
offline. Third-party runtime notices are in ./licenses.
EOF

output="$release_dir/bundle/Megavibe_${version}_linux_x86_64.tar.gz"
mkdir -p "$(dirname -- "$output")"
tar -C "$stage" -czf "$output" "Megavibe-$version-linux-x86_64"
printf 'Created %s\n' "$output"
