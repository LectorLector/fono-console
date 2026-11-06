#!/usr/bin/env sh
# Build FonoConsole.exe (Windows, amd64) from Linux/macOS. Needs Go 1.24+.
set -e
cd "$(dirname "$0")/.."
mkdir -p dist
./scripts/build-docs.sh
[ -f rsrc_windows_amd64.syso ] || python3 tools/mkicon_syso.py assets/icon.ico rsrc_windows_amd64.syso
GOOS=windows GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags "-H=windowsgui -s -w" -o dist/FonoConsole.exe .
# Demo build for the local machine (fake devices, no Windows APIs): ./dist/fono-demo
go build -o dist/fono-demo .
echo "dist/FonoConsole.exe ready"
