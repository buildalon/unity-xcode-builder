# Buildalon unity-xcode-builder

[![Discord](https://img.shields.io/discord/939721153688264824.svg?label=&logo=discord&logoColor=ffffff&color=7389D8&labelColor=6A7EC2)](https://discord.gg/VM9cWJ9rjH) [![marketplace](https://img.shields.io/static/v1?label=&labelColor=505050&message=Buildalon%20Actions&color=FF1E6F&logo=github-actions&logoColor=0076D6)](https://github.com/marketplace?query=buildalon) [![validate](https://github.com/buildalon/unity-xcode-builder/actions/workflows/validate.yml/badge.svg?branch=main)](https://github.com/buildalon/unity-xcode-builder/actions/workflows/validate.yml)

A GitHub Action to take Unity exported Xcode projects and automate the process of building, signing, archiving, notarizing, and uploading to Apple App Store Connect or Steam.

> [!NOTE]
> Steam uploads require an additional action step: [`upload-steam`](https://github.com/buildalon/upload-steam)

## How to use

The action runs on macOS runners. Its post step removes the temporary keychain, provisioning profile and App Store Connect key it installed.

### Workflow

To archive, export, and upload directly to Apple App Store Connect, use the following workflow configuration:

```yaml
jobs:
  build:
    runs-on: macos-latest
    steps:
      - uses: buildalon/unity-xcode-builder@v2
        id: xcode-build
        with:
          project-path: path/to/your/build/output/directory
          app-store-connect-key: ${{ secrets.APP_STORE_CONNECT_KEY }}
          app-store-connect-key-id: ${{ secrets.APP_STORE_CONNECT_KEY_ID }}
          app-store-connect-issuer-id: ${{ secrets.APP_STORE_CONNECT_ISSUER_ID }}
          team-id: ${{ secrets.APPLE_TEAM_ID }}
          export-option: app-store-connect

      - name: print outputs
        shell: bash
        env:
          EXECUTABLE: ${{ steps.xcode-build.outputs.executable }}
          OUTPUT_DIRECTORY: ${{ steps.xcode-build.outputs.output-directory }}
        run: |
          echo "Executable: ${EXECUTABLE}"
          ls -al "${OUTPUT_DIRECTORY}"
```

To export a notarized macOS installer package outside the App Store:

```yaml
      - uses: buildalon/unity-xcode-builder@v2
        with:
          project-path: path/to/your/build/output/directory
          app-store-connect-key: ${{ secrets.APP_STORE_CONNECT_KEY }}
          app-store-connect-key-id: ${{ secrets.APP_STORE_CONNECT_KEY_ID }}
          app-store-connect-issuer-id: ${{ secrets.APP_STORE_CONNECT_ISSUER_ID }}
          team-id: ${{ secrets.APPLE_TEAM_ID }}
          export-option: developer-id
          archive-type: pkg
          developer-id-application-certificate: ${{ secrets.DEVELOPER_ID_APPLICATION_CERT }}
          developer-id-application-certificate-password: ${{ secrets.SIGNING_CERT_PASSWORD }}
          developer-id-installer-certificate: ${{ secrets.DEVELOPER_ID_INSTALLER_CERT }}
          developer-id-installer-certificate-password: ${{ secrets.SIGNING_CERT_PASSWORD }}
```

### Secrets

This action requires several secrets that need to be setup in the repository or organization's action secret store.

- `APP_STORE_CONNECT_KEY`: The App Store Connect API AuthKey_*.p8 key encoded as base64 string.
- `APP_STORE_CONNECT_KEY_ID`: The App Store Connect API key id.
- `APP_STORE_CONNECT_ISSUER_ID`: The issuer ID of the App Store Connect API key.

> [!TIP]
> You can easily encode a file to base64 using the following command in linux, mac, or windows bash terminal:
>
> ```bash
> openssl base64 -in ./AuthKey_*.p8 -out ./AuthKey_*.txt
> ```

### Inputs

| Input | Description | Required | Default |
|-------|-------------|----------|---------|
| `xcode-version` | The version of Xcode to use for building the Xcode project. | false | `latest`, the [latest version of Xcode on the runner](https://github.com/actions/runner-images#available-images) |
| `project-path` | The directory that contains the exported xcode project from Unity. | false | Searches the workspace for `.xcodeproj` |
| `app-store-connect-key` | The App Store Connect API AuthKey_*.p8 key encoded as base64 string. | true | |
| `app-store-connect-key-id` | The App Store Connect API key id. | true | |
| `app-store-connect-issuer-id` | The issuer ID of the App Store Connect API key. | true | |
| `manual-signing-certificate` | Exported signing certificate.p12 encoded as base64 string. Overrides the automatic signing in Xcode. | false | Automatic signing |
| `manual-signing-certificate-password` | The password for the exported certificate. | If `manual-signing-certificate` is provided. | |
| `manual-signing-identity` | The signing identity to use for signing the Xcode project. | false | Parsed from the `manual-signing-certificate` |
| `provisioning-profile` | The provisioning profile to use as base64 string. Use when manually signing the Xcode project. | false | Automatic signing |
| `provisioning-profile-name` | The name of the provisioning profile file, including the type to use for signing the Xcode project. Must end with either `.mobileprovision` or `.provisionprofile`. | If `provisioning-profile` is provided. | |
| `team-id` | The team ID to use for signing the Xcode project. | false | Parsed from `manual-signing-certificate` if provided |
| `bundle-id` | The bundle ID of the Xcode project. Overrides the value in the exported Unity project. | false | Parsed from `.xcodeproj` |
| `configuration` | The configuration to build the Xcode project with. | false | `Release` |
| `scheme` | The scheme to use when building the xcode project. | false | |
| `destination` | The destination to use when building the xcode project. | false | `generic/platform={platform}` |
| `platform` | The platform to build for. Can be one of `iOS`, `macOS`, `tvOS`, `visionOS`. | false | Parsed from `.xcodeproj` |
| `platform-sdk-version` | The version of the platform SDK to use for building the Xcode project. | false | The latest version of the platform SDK defined in the `.xcodeproj` |
| `export-option` | The export option to use for exporting the Xcode project. Can be one of `app-store-connect`, `steam`, `release-testing`, `enterprise`, `debugging`, `developer-id`, `mac-application`, `development`. | false | `development` |
| `export-option-plist` | The path to custom export option plist file to use when exporting the Xcode project. Overrides `export-option`. | false | |
| `entitlements-plist` | The path to custom entitlements plist file. | false | Generates [default hardened runtime entitlements](https://developer.apple.com/documentation/security/hardened-runtime) |
| `notarize` | Whether to notarize the exported macOS application. Always `true` for `steam` exports and `pkg` archives. | false | `true` if `export-option !== app-store-connect` |
| `archive-type` | The archive type to use when exporting macOS applications when not uploading to the App Store. Can be one of `app` or `pkg`. Forces `app` if `export-option === steam`. | false | `app` |
| `upload` | Whether to upload the exported Xcode project to App Store Connect. | false | `true` if `export-option === app-store-connect` |
| `whats-new` | When `upload === true`, let your testers know what you would like them to test in this build. This information will be available to testers in all groups who have access to this build. | false | The last git commit sha, current branch name, and commit message up to 4000 characters |
| `auto-increment-build-number` | Whether to automatically increment the `CFBundleVersion` in the Xcode project. | false | `true` |
| `test-groups` | One or more test groups to automatically add to the build when uploading to TestFlight. When using multiple groups, separate them with commas. | false | |
| `submit-for-review` | Whether to submit the build for review when uploading to TestFlight. | false | `false` |
| `developer-id-application-certificate` | The `Developer ID Application` certificate encoded as base64 string. | If `notarize` is `true` for a macOS export, which `steam` exports and `pkg` archives always are. | |
| `developer-id-application-certificate-password` | The password for the `Developer ID Application` certificate. | If `developer-id-application-certificate` is provided. | |
| `developer-id-installer-certificate` | The `Developer ID Installer` certificate encoded as base64 string. | If `archive-type` is `pkg`. | |
| `developer-id-installer-certificate-password` | The password for the `Developer ID Installer` certificate. | If `developer-id-installer-certificate` is provided. | |

The deprecated `certificate`, `certificate-password` and `signing-identity` inputs still work; use `manual-signing-certificate`, `manual-signing-certificate-password` and `manual-signing-identity` instead.

A macOS export with `notarize: false` no longer looks for the Developer ID certificates, so non-notarized `development` or `debugging` exports don't need them.

### Outputs

| Output | Description |
|--------|-------------|
| `executable` | The path to the exported archive executable. |
| `output-directory` | The path to the export output directory. |

The action runs on Node 24, so self-hosted runners need [actions/runner](https://github.com/actions/runner) v2.327.1 or newer.
