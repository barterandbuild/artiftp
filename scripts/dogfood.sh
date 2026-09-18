#!/usr/bin/env bash
# Thin wrapper — real dogfood is scripts/dogfood.ts
set -euo pipefail
cd "$(dirname "$0")/.."
exec npx tsx scripts/dogfood.ts
