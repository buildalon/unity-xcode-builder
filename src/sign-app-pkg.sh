#!/bin/bash
# This script is meant to sign macOS .pkg files with optional signing identity.
# Usage: ./sign-app-pkg.sh <path_to_pkg> "<signing_identity>"
# Example: ./sign-app-pkg.sh /path/to/MyApp.pkg "Developer ID Installer: Your Name (Team ID)"

set -e

PKG_PATH="$1"
KEYCHAIN_PATH="$2"

DEVELOPER_ID_INSTALLER_SIGNING_IDENTITY=$(security find-identity -v "$KEYCHAIN_PATH" | grep "Developer ID Installer" | awk -F'"' '{print $2}' | head -n 1)

if [ -z "$DEVELOPER_ID_INSTALLER_SIGNING_IDENTITY" ]; then
    echo "No 'Developer ID Installer' signing identity found in $KEYCHAIN_PATH!"
    exit 1
fi

productsign --sign "$DEVELOPER_ID_INSTALLER_SIGNING_IDENTITY" --keychain "$KEYCHAIN_PATH" "$PKG_PATH" "${PKG_PATH%.pkg}-signed.pkg"

# verify the signed package
if ! pkgutil --check-signature "${PKG_PATH%.pkg}-signed.pkg"; then
    exit 1
fi

# replace the original package with the signed one
rm "$PKG_PATH"
mv "${PKG_PATH%.pkg}-signed.pkg" "$PKG_PATH"
echo "Package signed successfully!"
exit 0
