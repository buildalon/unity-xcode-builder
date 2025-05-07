#!/bin/bash
# This script is meant to sign macOS .pkg files with optional signing identity.
# Usage: ./sign-app-pkg.sh <path_to_pkg> "<signing_identity>"
# Example: ./sign-app-pkg.sh /path/to/MyApp.pkg "Developer ID Installer: Your Name (Team ID)"

PKG_PATH="$1"
SIGNING_IDENTITY="$2"

if [ -z "$SIGNING_IDENTITY" ]; then
    # find the Developer ID Installer signing identity
    SIGNING_IDENTITY=$(security find-identity -v | grep "Developer ID Installer" | awk -F'"' '{print $2}' | head -n 1)
fi

if [ -z "$SIGNING_IDENTITY" ]; then
    echo "No 'Developer ID Installer' signing identity found!"
    exit 1
fi

productsign --sign "$SIGNING_IDENTITY" "$PKG_PATH" "${PKG_PATH%.pkg}-signed.pkg"

# verify the signed package
if ! pkgutil --check-signature "${PKG_PATH%.pkg}-signed.pkg"; then
    exit 1
fi

# replace the original package with the signed one
rm "$PKG_PATH"
mv "${PKG_PATH%.pkg}-signed.pkg" "$PKG_PATH"
echo "Package signed successfully!"
