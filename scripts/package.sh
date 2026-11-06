#!/usr/bin/env bash
# Build a release zip: FonoConsole.exe + bundled Equalizer APO installer +
# setup scripts + licenses. Usage: scripts/package.sh 2.3.0
set -euo pipefail
cd "$(dirname "$0")/.."
VER="${1:-dev}"
OUT="dist/FonoConsole-$VER"
rm -rf "$OUT" && mkdir -p "$OUT/bundled" "$OUT/scripts"
./scripts/build-docs.sh
python3 tools/mkicon_syso.py assets/icon.ico rsrc_windows_amd64.syso
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H=windowsgui -s -w" -o "$OUT/FonoConsole.exe" .
cp scripts/setup.ps1 scripts/setup.cmd "$OUT/scripts/"
cp LICENSE THIRD_PARTY.md "$OUT/"

# Equalizer APO (GPLv2): ship the official, unmodified installer and say where it came from.
EAPO_URL="${EAPO_URL:-https://sourceforge.net/projects/equalizerapo/files/latest/download}"
if curl -fL --retry 3 -o "$OUT/bundled/EqualizerAPO-x64-setup.exe" "$EAPO_URL"; then
  SUM=$(sha256sum "$OUT/bundled/EqualizerAPO-x64-setup.exe" | cut -d' ' -f1)
  cat > "$OUT/bundled/SOURCES.txt" <<TXT
EqualizerAPO-x64-setup.exe
  Project : Equalizer APO by Jonas Thedering
  License : GNU General Public License v2.0 (unmodified official installer)
  Source  : https://sourceforge.net/projects/equalizerapo/  (source code available there)
  Fetched : $EAPO_URL  on $(date -u +%Y-%m-%d)
  SHA-256 : $SUM
TXT
else
  echo "warning: could not download Equalizer APO; the setup wizard will open the official page instead" >&2
  rmdir "$OUT/bundled" 2>/dev/null || true
fi
(cd dist && rm -f "FonoConsole-$VER.zip" && zip -qr "FonoConsole-$VER.zip" "FonoConsole-$VER")
echo "dist/FonoConsole-$VER.zip"
