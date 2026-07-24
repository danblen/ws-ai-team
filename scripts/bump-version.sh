#!/bin/sh
# Bump BUILD_NUM in src/version.ts, commit, and push.
# Usage: sh scripts/bump-version.sh
set -e
cd "$(dirname "$0")/.."

VERSION_FILE="src/version.ts"

# Read current build number from version.ts
CUR=$(sed -n 's/^export const BUILD_NUM = \([0-9]*\);/\1/p' "$VERSION_FILE")
if [ -z "$CUR" ]; then
  echo "Error: Could not parse BUILD_NUM from $VERSION_FILE"
  exit 1
fi

NEXT=$((CUR + 1))

# Write new version.ts
cat > "$VERSION_FILE" <<VEOF
// Auto-generated — run scripts/bump-version.sh before each push.
export const APP_VERSION = '1.0.0' as const;
export const BUILD_NUM = $NEXT;
VEOF

echo "BUILD_NUM: $CUR -> $NEXT"

git add "$VERSION_FILE"

# Only commit if there's a change (skip if already up to date, though unlikely)
git diff --cached --exit-code "$VERSION_FILE" && echo "No change needed." && exit 0

git commit -m "chore: bump build number to $NEXT"
git push
echo "Pushed with BUILD_NUM=$NEXT"
