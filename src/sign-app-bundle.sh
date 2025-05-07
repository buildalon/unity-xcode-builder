#!/bin/bash
# This script is used to sign macOS app bundles with a specified entitlements file and signing identity.
# Usage: ./signing.sh <path_to_app_bundle> <path_to_entitlements_path> "<signing_identity>"
# Example: ./signing.sh /path/to/MyApp.app /path/to/entitlements.plist "Developer ID Application: Your Name (Team ID)"

set -xe

APP_BUNDLE_PATH="$1"
ENTITLEMENTS_PATH="$2"
SIGNING_IDENTITY="$3"

# remove any metadata from the app bundle
xattr -cr "$APP_BUNDLE_PATH"

# verify the app bundle
if codesign --verify --verbose=2 "$APP_BUNDLE_PATH"; then
    exit 0
fi

if [ -z "$SIGNING_IDENTITY" ]; then
    # get the signing identity that matches Developer ID Application
    SIGNING_IDENTITY=$(security find-identity -p codesigning -v | grep "Developer ID Application" | awk -F'"' '{print $2}' | head -n 1)
fi

if [ -z "$SIGNING_IDENTITY" ]; then
    echo "No 'Developer ID Application' signing identity found!"
    exit 1
fi

# sign *.bundles and delete any existing *.meta files from them
find "$APP_BUNDLE_PATH" -name "*.bundle" -exec find {} -name '*.meta' -delete \; -exec codesign --deep --force --verify --verbose --timestamp --options runtime --entitlements "$ENTITLEMENTS_PATH" --sign "$SIGNING_IDENTITY" {} \;

# sign any *.dylibs
find "$APP_BUNDLE_PATH" -name "*.dylib" -exec codesign --force --verify --verbose --timestamp --options runtime --entitlements "$ENTITLEMENTS_PATH" --sign "$SIGNING_IDENTITY" {} \;

#sign the app bundle
codesign --deep --force --verify --verbose --timestamp --options runtime --entitlements "$ENTITLEMENTS_PATH" --sign "$SIGNING_IDENTITY" "$APP_BUNDLE_PATH"

# verify the app bundle
if ! codesign --verify --verbose=2 "$APP_BUNDLE_PATH"; then
    exit 1
fi
