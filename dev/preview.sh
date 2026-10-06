#!/bin/sh
# Serves the UI with the mock backend at http://localhost:${PORT:-8790}/?s=devices  (dev only)
set -eu
here="$(cd "$(dirname "$0")/.." && pwd)"
out="$(mktemp -d)"
cp -r "$here/ui/." "$out/"
cp "$here/dev/mock-tauri.js" "$out/"
sed -i 's#<script src="guide.js"></script>#<script src="mock-tauri.js"></script>\n<script src="guide.js"></script>#' "$out/index.html"
echo "preview: http://localhost:${PORT:-8790}/?s=devices   (files in $out)"
cd "$out" && exec python3 -m http.server "${PORT:-8790}" --bind 0.0.0.0
