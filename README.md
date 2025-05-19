# Buildalon unity-xcode-builder

[![Discord](https://img.shields.io/discord/939721153688264824.svg?label=&logo=discord&logoColor=ffffff&color=7389D8&labelColor=6A7EC2)](https://discord.gg/VM9cWJ9rjH) [![marketplace](https://img.shields.io/static/v1?label=&labelColor=505050&message=Buildalon%20Actions&color=FF1E6F&logo=github-actions&logoColor=0076D6)](https://github.com/marketplace?query=buildalon) [![validate](https://github.com/buildalon/unity-xcode-builder/actions/workflows/validate.yml/badge.svg?branch=main)](https://github.com/buildalon/unity-xcode-builder/actions/workflows/validate.yml)

A GitHub Action to take Unity exported Xcode projects and automate the process of building, signing, archiving, notarizing, and uploading to Apple App Store Connect or Steam.

> [!NOTE]
> Steam uploads require an additional action step: [`upload-steam`](https://github.com/buildalon/upload-steam)

## How to use

### workflow

To archive, export, and upload directly to Apple App Store Connect, use the following workflow configuration:

```yaml
steps:
  - uses: buildalon/unity-xcode-builder@v1
    id: xcode-build
    with:
      project-path: '/path/to/your/build/output/directory'
      app-store-connect-key: ${{ secrets.APP_STORE_CONNECT_KEY }}
      app-store-connect-key-id: ${{ secrets.APP_STORE_CONNECT_KEY_ID }}
      app-store-connect-issuer-id: ${{ secrets.APP_STORE_CONNECT_ISSUER_ID }}
      team-id: ${{ secrets.APPLE_TEAM_ID }}

  - run: |
      echo ${{ steps.xcode-build.outputs.executable }}
      ls -al ${{ steps.xcode-build.outputs.output-directory }}
```

### inputs

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

| name | description | required |
| ---- | ----------- | -------- |
| `xcode-version` | The version of Xcode to use for building the Xcode project. | Defaults to the [latest version of Xcode on the runner](https://github.com/actions/runner-images#available-images). |
| `project-path` | The directory that contains the exported xcode project from Unity. | Defaults to searching the workspace for `.xcodeproj` |
| `app-store-connect-key` | The App Store Connect API AuthKey_*.p8 key encoded as base64 string. | true |
| `app-store-connect-key-id` | The App Store Connect API key id. | true |
| `app-store-connect-issuer-id` | The issuer ID of the App Store Connect API key. | true |
| `manual-signing-certificate` | Exported signing certificate.p12 encoded as base64 string. Overrides the automatic signing in Xcode. | Defaults to Automatic signing. |
| `manual-signing-certificate-password` | The password for the exported certificate. | Required if `manual-signing-certificate` is provided. |
| `manual-signing-identity` | The signing identity to use for signing the Xcode project. | Parsed from the `manual-signing-certificate` if not provided. |
| `provisioning-profile` | The provisioning profile to use as base64 string. Use when manually signing the Xcode project. | Defaults to Automatic signing. |
| `provisioning-profile-name` | The name of the provisioning profile file, including the type to use for signing the Xcode project. Must end with either `.mobileprovision` or `.provisionprofile`. | Required if `provisioning-profile` is provided. |
| `team-id` | The team ID to use for signing the Xcode project. | Defaults to parsing team ID from `manual-signing-certificate` if provided. |
| `bundle-id` | The bundle ID of the Xcode project. Overrides the value in the exported Unity project. | Defaults to parsing bundle ID from `.xcodeproj`. |
| `configuration` | The configuration to build the Xcode project with. | Defaults to `Release`. |
| `scheme` | The scheme to use when building the xcode project. | false |
| `destination` | The destination to use when building the xcode project. | Defaults to `generic/platform={platform}`. |
| `platform` | The platform to build for. Can be one of `iOS`, `macOS`, `tvOS`, `visionOS`. | Defaults to parsing platform from `.xcodeproj`. |
| `platform-sdk-version` | The version of the platform SDK to use for building the Xcode project. | Defaults to the latest version of the platform SDK defined in the `.xcodeproj`. |
| `export-option` | The export option to use for exporting the Xcode project. Can be one of `app-store-connect`, `steam`, `release-testing`, `enterprise`, `debugging`, `developer-id`, `mac-application`. | Defaults to `development` |
| `export-option-plist` | The path to custom export option plist file to use when exporting the Xcode project. | Overrides `export-option`. |
| `entitlements-plist` | The path to custom entitlements plist file. | Generates [default hardened runtime entitlements](https://developer.apple.com/documentation/security/hardened-runtime) if not provided. |
| `notarize` | Whether to notarize the exported Xcode project. | Defaults to `true` if `export-option !== app-store-connect`. |
| `archive-type` | The archive type to use when exporting macOS applications when not uploading to the App Store. Can be one of `app` or `pkg`. | Defaults to `app`. Forces `app` if `export-option === steam`. |
| `upload` | Whether to upload the exported Xcode project to App Store Connect. | Defaults to `true` if `export-option === app-store-connect`. |
| `whats-new` | When `uploading === true`, Let your testers know what you would like them to test in this build. This information will be available to testers in all groups who have access to this build. | Defaults to the last git commit sha, current branch name, and commit message up to 4000 characters. |
| `auto-increment-build-number` | Whether to automatically increment the `CFBundleVersion` in the Xcode project. | Defaults to `true` if `export-option === app-store-connect`. |
| `test-groups` | One or more test groups to automatically add to the build when uploading to TestFlight. When using multiple groups, separate them with commas. | None by default. |
| `submit-for-review` | Whether to submit the build for review when uploading to App Store Connect. | Defaults to `false`. |
| `developer-id-application-certificate` | The `Developer ID Application` certificate encoded as base64 string. | Required if `export-option === steam` or `export-option === developer-id` or `notarize === true`. |
| `developer-id-application-certificate-password` | The password for the `Developer ID Application` certificate. | Required if `developer-id-application-certificate` is provided. |
| `developer-id-installer-certificate` | The `Developer ID Installer` certificate encoded as base64 string. | Required when creating an installer package for macOS application. |
| `developer-id-installer-certificate-password` | The password for the `Developer ID Installer` certificate. | Required if `developer-id-installer-certificate` is provided. |

### outputs

- `executable`: Path to the exported archive executable.
- `output-directory`: The path to the export output directory.
