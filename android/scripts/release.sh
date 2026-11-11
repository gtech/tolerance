#!/usr/bin/env bash
# Publish the sideloaded (full) build to GitHub releases on gtech/tolerance.
#
#   1. Bump versionCode and versionName in app/build.gradle.kts and commit
#   2. scripts/release.sh "What changed, one line per item"
#
# Creates release android-v<versionName> with tolerance-android.apk, never marked Latest
# (that's the extension's), and replaces the APK on the rolling android-latest release, which
# the site links to:
#   https://github.com/gtech/tolerance/releases/download/android-latest/tolerance-android.apk
# The app's update check looks for the newest android-v* release.
#
# Needs keystore.properties (the release key: back it up, it can never be replaced) and an
# authenticated gh.
set -euo pipefail
cd "$(dirname "$0")/.."

REPO=gtech/tolerance
NOTES=${1:?usage: scripts/release.sh "release notes"}
VERSION=$(sed -n 's/^ *versionName = "\(.*\)"/\1/p' app/build.gradle.kts)
TAG="android-v$VERSION"

[ -f keystore.properties ] || { echo "keystore.properties missing: can't sign"; exit 1; }
if gh release view "$TAG" --repo "$REPO" >/dev/null 2>&1; then
    echo "$TAG already exists: bump versionName first"; exit 1
fi

./gradlew testFullDebugUnitTest testPlayDebugUnitTest assembleFullRelease
APK=build/outputs/apk/full/release/app-full-release.apk
OUT=$(mktemp -d)/tolerance-android.apk
cp app/"$APK" "$OUT"

gh release create "$TAG" "$OUT" --repo "$REPO" --latest=false \
    --title "Tolerance for Android $VERSION" --notes "$NOTES"

if gh release view android-latest --repo "$REPO" >/dev/null 2>&1; then
    gh release upload android-latest "$OUT" --repo "$REPO" --clobber
    gh release edit android-latest --repo "$REPO" --title "Tolerance for Android (latest: $VERSION)"
else
    gh release create android-latest "$OUT" --repo "$REPO" --latest=false \
        --title "Tolerance for Android (latest: $VERSION)" \
        --notes "Always the newest Android build. Versioned releases are tagged android-v*."
fi

echo "Published $TAG"
echo "Download link: https://github.com/$REPO/releases/download/android-latest/tolerance-android.apk"
