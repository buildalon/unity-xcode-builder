#!/bin/bash
# This script is used to sign macOS app bundles with a specified entitlements file and signing identity.
# Usage: ./signing.sh <path_to_app_bundle> <path_to_entitlements_path> "<DEVELOPER_ID_APPLICATION_SIGNING_IDENTITY>"
# Example: ./signing.sh /path/to/MyApp.app /path/to/entitlements.plist "Developer ID Application: Your Name (Team ID)"

set -e

APP_BUNDLE_PATH="$1"
ENTITLEMENTS_PATH="$2"
KEYCHAIN_PATH="$3"
KEYCHAIN_PASSWORD="$4"

# remove any metadata from the app bundle
xattr -cr "$APP_BUNDLE_PATH"

# check if the keychain is unlocked
if ! security show-keychain-info "$KEYCHAIN_PATH" | grep -q "unlocked"; then
    echo "Keychain $KEYCHAIN_PATH is locked. Unlocking..."
    security unlock-keychain -p "$KEYCHAIN_PASSWORD" "$KEYCHAIN_PATH"
fi

DEVELOPER_ID_APPLICATION_SIGNING_IDENTITY=$(security find-identity -p codesigning -v "$KEYCHAIN_PATH" | grep "Developer ID Application" | awk -F'"' '{print $2}' | head -n 1)

if [ -z "$DEVELOPER_ID_APPLICATION_SIGNING_IDENTITY" ]; then
    echo "No 'Developer ID Application' signing identity found in $KEYCHAIN_PATH!"
    exit 1
fi

# check if the bundle is already signed with the same identity, if so, skip and return 0
if codesign -vvv --deep --strict --keychain "$KEYCHAIN_PATH" "$APP_BUNDLE_PATH" 2>&1 | grep -q "signed with identity"; then
    echo "App bundle is already signed with the same identity. Skipping signing."
    exit 0
fi

# sign *.bundles and delete any existing *.meta files from them
find "$APP_BUNDLE_PATH" -name "*.bundle" -exec find {} -name '*.meta' -delete \; -exec codesign --force --verify --verbose --timestamp --options runtime --keychain "$KEYCHAIN_PATH" --sign "$DEVELOPER_ID_APPLICATION_SIGNING_IDENTITY" {} \;

# sign any *.dylibs
find "$APP_BUNDLE_PATH" -name "*.dylib" -exec codesign --force --verify --verbose --timestamp --options runtime --keychain "$KEYCHAIN_PATH" --sign "$DEVELOPER_ID_APPLICATION_SIGNING_IDENTITY" {} \;

#sign the main app bundle
codesign --deep --force --verify --verbose --timestamp --options runtime --entitlements "$ENTITLEMENTS_PATH" --keychain "$KEYCHAIN_PATH" --sign "$DEVELOPER_ID_APPLICATION_SIGNING_IDENTITY" "$APP_BUNDLE_PATH"

# verify the app bundle
if ! codesign --verify --deep --strict --verbose=2 --keychain "$KEYCHAIN_PATH" "$APP_BUNDLE_PATH"; then
    exit 1
fi

echo "App bundle signed successfully!"
exit 0
