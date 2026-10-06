#!/usr/bin/env bash
# Build the iPhone app on this Mac and upload it to TestFlight, signed with the Apple developer
# account you are signed in to in Xcode (Xcode → Settings → Accounts).
#
#   APPLE_TEAM_ID=ABCDE12345 ./scripts/testflight.sh [server-url]
#
#   APPLE_TEAM_ID      your 10-character Team ID (developer.apple.com/account → Membership details)
#   VINCERA_BUNDLE_ID  optional; default com.vincera.app. It must match the app you created in
#                      App Store Connect (My Apps → + → New App).
#   server-url         optional; the Vincera server the app talks to by default. People can change
#                      it on the sign-in screen, so a tunnel address can be typed in later.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${APPLE_TEAM_ID:?Set APPLE_TEAM_ID to your Apple Team ID (developer.apple.com/account → Membership details).}"
export APPLE_TEAM_ID
export VINCERA_BUNDLE_ID="${VINCERA_BUNDLE_ID:-com.vincera.app}"
if [ "${1:-}" != "" ]; then export EXPO_PUBLIC_API_URL="$1"; fi

command -v xcodebuild >/dev/null || { echo "Xcode is needed (xcode-select --install, then open Xcode once)."; exit 1; }
command -v node >/dev/null || { echo "Node.js 22 or newer is needed (https://nodejs.org)."; exit 1; }
command -v pod >/dev/null || { echo "CocoaPods is needed: brew install cocoapods"; exit 1; }

BUILD_NUMBER="${BUILD_NUMBER:-$(date -u +%Y%m%d%H%M)}"
echo "▸ Bundle id $VINCERA_BUNDLE_ID, team $APPLE_TEAM_ID, build $BUILD_NUMBER"
echo "▸ Default server: ${EXPO_PUBLIC_API_URL:-http://localhost:3000 (change it on the sign-in screen)}"

echo "▸ Installing dependencies"
npm ci

echo "▸ Generating the Xcode project"
npx expo prebuild --platform ios --clean --no-install
(cd ios && pod install)

WORKSPACE=$(cd ios && ls -d *.xcworkspace | head -n 1)
SCHEME="${WORKSPACE%.xcworkspace}"
mkdir -p build
rm -rf build/Vincera.xcarchive build/export

echo "▸ Archiving ($SCHEME)"
xcodebuild \
  -workspace "ios/$WORKSPACE" \
  -scheme "$SCHEME" \
  -configuration Release \
  -destination "generic/platform=iOS" \
  -archivePath build/Vincera.xcarchive \
  -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$APPLE_TEAM_ID" \
  CODE_SIGN_STYLE=Automatic \
  CURRENT_PROJECT_VERSION="$BUILD_NUMBER" \
  archive

cat > build/ExportOptions.plist <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>method</key><string>app-store-connect</string>
  <key>destination</key><string>upload</string>
  <key>teamID</key><string>$APPLE_TEAM_ID</string>
  <key>signingStyle</key><string>automatic</string>
  <key>uploadSymbols</key><true/>
</dict>
</plist>
PLIST

echo "▸ Uploading to App Store Connect"
xcodebuild \
  -exportArchive \
  -archivePath build/Vincera.xcarchive \
  -exportOptionsPlist build/ExportOptions.plist \
  -exportPath build/export \
  -allowProvisioningUpdates

echo
echo "✓ Uploaded build $BUILD_NUMBER. It shows up in App Store Connect → TestFlight after Apple's"
echo "  processing (usually 5–30 minutes). Add yourself under Internal Testing, then install it"
echo "  from the TestFlight app on your iPhone."
