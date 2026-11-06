#!/usr/bin/env sh
# Copy the UI into docs/app so the tutorial site (GitHub Pages: /docs) and the
# in-app guide (/guide/) can run it as a live demo with the simulated backend.
set -e
cd "$(dirname "$0")/.."
rm -rf docs/app && mkdir -p docs/app && cp -r web/. docs/app/
echo "docs/app updated"
