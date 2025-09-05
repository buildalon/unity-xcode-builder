import { XcodeProject } from './XcodeProject';
import { spawn } from 'child_process';
import { exec } from '@actions/exec';
import glob = require('@actions/glob');
import github = require('@actions/github');
import plist = require('plist');
import path = require('path');
import fs = require('fs');
import semver = require('semver');
import {
    DeepEqual,
    log,
    matchRegexPattern,
    getFirstPathWithGlob,
    getFileContents,
    getPathsWithGlob
} from './utilities';
import { SemVer } from 'semver';
import core = require('@actions/core');
import {
    AppleCredential
} from './AppleCredential';
import {
    GetLatestBundleVersion,
    UpdateTestDetails,
    UnauthorizedError,
    GetAppId,
} from './AppStoreConnectClient';

const xcodebuild = '/usr/bin/xcodebuild';
const xcrun = '/usr/bin/xcrun';
const WORKSPACE = process.env.GITHUB_WORKSPACE || process.cwd();

export async function GetOrSetXcodeVersion(): Promise<SemVer> {
    let xcodeVersionString = core.getInput('xcode-version');

    if (xcodeVersionString) {
        core.info(`Setting xcode version to ${xcodeVersionString}`);
        let xcodeVersionOutput = '';

        const installedExitCode = await exec('xcodes', ['installed'], {
            listeners: {
                stdout: (data: Buffer) => {
                    xcodeVersionOutput += data.toString();
                }
            }
        });

        if (installedExitCode !== 0) {
            throw new Error('Failed to get installed Xcode versions!');
        }

        const installedXcodeVersions = xcodeVersionOutput.split('\n').map(line => {
            const match = line.match(/(\d+\.\d+(\s\w+)?)/);
            return match ? match[1] : null;
        }).filter(Boolean) as string[];

        core.info(`Installed Xcode versions:`);
        installedXcodeVersions.forEach(version => core.info(`  > ${version}`));

        if (installedXcodeVersions.length === 0 || !xcodeVersionString.includes('latest')) {
            if (installedXcodeVersions.length === 0 || !installedXcodeVersions.includes(xcodeVersionString)) {
                throw new Error(`Xcode version ${xcodeVersionString} is not installed! You will need to install this is a step before this one.`);
            }
        } else {
            // Exclude versions containing 'Beta' and select the latest version
            const nonBetaVersions = installedXcodeVersions.filter(v => !/Beta/i.test(v));

            if (nonBetaVersions.length === 0) {
                throw new Error('No Xcode versions installed!');
            }

            xcodeVersionString = nonBetaVersions[nonBetaVersions.length - 1];
        }

        core.info(`Selecting latest installed Xcode version ${xcodeVersionString}...`);
        const selectExitCode = await exec('xcodes', ['select', xcodeVersionString]);

        if (selectExitCode !== 0) {
            throw new Error(`Failed to select Xcode version ${xcodeVersionString}!`);
        }
    }

    let xcodeVersionOutput = '';
    await exec('xcodebuild', ['-version'], {
        listeners: {
            stdout: (data: Buffer) => {
                xcodeVersionOutput += data.toString();
            }
        }
    });

    const xcodeVersionMatch = xcodeVersionOutput.match(/Xcode (?<version>\d+\.\d+)/);

    if (!xcodeVersionMatch) {
        throw new Error('Failed to get Xcode version!');
    }

    const selectedXcodeVersionString = xcodeVersionMatch.groups.version;

    if (!selectedXcodeVersionString) {
        throw new Error('Failed to parse Xcode version!');
    }

    if (xcodeVersionString !== selectedXcodeVersionString) {
        throw new Error(`Selected Xcode version ${selectedXcodeVersionString} does not match requested version ${xcodeVersionString}!`);
    }

    return semver.coerce(xcodeVersionString);
}

export async function GetProjectDetails(credential: AppleCredential, xcodeVersion: SemVer): Promise<XcodeProject> {
    const projectPathInput = core.getInput('project-path') || `${WORKSPACE}/**/*.xcodeproj`;
    core.info(`Project path input: ${projectPathInput}`);
    let projectPath = undefined;
    const globber = await glob.create(projectPathInput);
    const files = await globber.glob();

    if (!files || files.length === 0) {
        throw new Error(`No project found at: ${projectPathInput}`);
    }

    core.info(`Files found during search: ${files.join(', ')}`);
    const excludedProjects = ['GameAssembly', 'UnityFramework', 'Pods'];

    for (const file of files) {
        if (file.includes('DerivedData')) { continue; }
        if (file.endsWith('.xcodeproj')) {
            const projectBaseName = path.basename(file, '.xcodeproj');

            if (excludedProjects.includes(projectBaseName)) {
                continue;
            }

            core.info(`Found Xcode project: ${file}`);
            projectPath = file;
            break;
        }
    }

    if (!projectPath) {
        throw new Error(`Invalid project-path! Unable to find .xcodeproj in ${projectPathInput}. ${files.length} files were found but none matched.\n${files.join(', ')}`);
    }

    core.info(`Resolved Project path: ${projectPath}`);
    await fs.promises.access(projectPath, fs.constants.R_OK);
    const projectDirectory = path.dirname(projectPath);
    core.info(`Project directory: ${projectDirectory}`);
    const projectFiles = await fs.promises.readdir(projectDirectory);
    projectFiles.forEach(file => core.info(`  > ${file}`));
    const projectName = path.basename(projectPath, '.xcodeproj');
    const buildSettings = await getBuildSettings(projectPath);
    const scheme = await getProjectScheme(projectPath);
    const platform = await getSupportedPlatform(projectPath);
    core.info(`Platform: ${platform}`);

    if (platform !== 'macOS') {
        const platformSdkVersion = await getPlatformSdkVersion(buildSettings);
        await downloadPlatformAndSdk(platform, platformSdkVersion);
        await getSdkInfo(platform, platformSdkVersion);
    }

    const configuration = core.getInput('configuration') || 'Release';
    core.info(`Configuration: ${configuration}`);

    if (!platform) {
        throw new Error('Unable to determine the platform to build for.');
    }

    const destination: string = await getDestination(projectPath, scheme, platform);
    core.info(`Destination: ${destination}`);
    const bundleId = getBundleId(buildSettings);
    core.info(`Bundle ID: ${bundleId}`);

    if (!bundleId) {
        throw new Error('Unable to determine the bundle ID');
    }

    let infoPlistPath = `${projectDirectory}/${projectName}/Info.plist`;

    if (!fs.existsSync(infoPlistPath)) {
        infoPlistPath = `${projectDirectory}/Info.plist`;
    }

    core.info(`Info.plist path: ${infoPlistPath}`);
    let infoPlistContent: string = await getFileContents(infoPlistPath, false);
    const infoPlist = plist.parse(infoPlistContent) as any;
    let cFBundleShortVersionString: string = infoPlist['CFBundleShortVersionString'];

    if (cFBundleShortVersionString) {
        const semverRegex = /^(?<major>\d+)\.(?<minor>\d+)\.(?<revision>\d+)/;
        const match = cFBundleShortVersionString.match(semverRegex);

        if (match) {
            const { major, minor, revision } = match.groups as { [key: string]: string };
            cFBundleShortVersionString = `${major}.${minor}.${revision}`;
            infoPlist['CFBundleShortVersionString'] = cFBundleShortVersionString.toString();

            try {
                core.debug(`Updating Info.plist`);
                await fs.promises.writeFile(infoPlistPath, plist.build(infoPlist));
            } catch (error) {
                throw new Error(`Failed to update Info.plist!\n${error}`);
            }
        } else {
            throw new Error(`Invalid CFBundleShortVersionString format: ${cFBundleShortVersionString}`);
        }
    }

    core.info(`CFBundleShortVersionString: ${cFBundleShortVersionString}`);
    const cFBundleVersion = infoPlist['CFBundleVersion'] as string;
    core.info(`CFBundleVersion: ${cFBundleVersion}`);

    const projectRef = new XcodeProject(
        projectPath,
        projectName,
        projectDirectory,
        platform,
        destination,
        configuration,
        bundleId,
        cFBundleShortVersionString,
        cFBundleVersion,
        scheme,
        credential,
        xcodeVersion
    );

    projectRef.autoIncrementBuildNumber = core.getInput('auto-increment-build-number') === 'true';
    await getExportOptions(projectRef);
    let entitlementsPath = core.getInput('entitlements-plist');

    if (!entitlementsPath) {
        if (projectRef.platform === 'macOS') {
            projectRef.entitlementsPath = await getDefaultEntitlementsMacOS(projectRef);
        }
    } else {
        projectRef.entitlementsPath = entitlementsPath;
    }

    if (projectRef.entitlementsPath) {
        await getFileContents(projectRef.entitlementsPath);
    }

    if (projectRef.isAppStoreUpload()) {
        projectRef.appId = await GetAppId(projectRef);

        if (projectRef.autoIncrementBuildNumber) {
            let projectBundleVersionPrefix = '';
            let projectBundleVersionNumber: number;

            if (!cFBundleVersion || cFBundleVersion.length === 0) {
                projectBundleVersionNumber = 0;
            } else if (cFBundleVersion.includes('.')) {
                const versionParts = cFBundleVersion.split('.');
                projectBundleVersionNumber = parseInt(versionParts[versionParts.length - 1]);
                projectBundleVersionPrefix = versionParts.slice(0, -1).join('.') + '.';
            } else {
                projectBundleVersionNumber = parseInt(cFBundleVersion);
            }

            let lastVersionNumber: number;
            let versionPrefix = '';
            let lastBundleVersion: string = null;

            try {
                lastBundleVersion = await GetLatestBundleVersion(projectRef);
            } catch (error) {
                if (error instanceof UnauthorizedError) {
                    throw error;
                }
            }

            if (!lastBundleVersion || lastBundleVersion.length === 0) {
                lastVersionNumber = -1;
            } else if (lastBundleVersion.includes('.')) {
                const versionParts = lastBundleVersion.split('.');
                lastVersionNumber = parseInt(versionParts[versionParts.length - 1]);
                versionPrefix = versionParts.slice(0, -1).join('.') + '.';
            } else {
                lastVersionNumber = parseInt(lastBundleVersion);
            }

            if (projectBundleVersionPrefix.length > 0 && projectBundleVersionPrefix !== versionPrefix) {
                core.debug(`Project version prefix: ${projectBundleVersionPrefix}`);
                core.debug(`Last bundle version prefix: ${versionPrefix}`);
                if (lastVersionNumber > projectBundleVersionNumber) {
                    projectBundleVersionPrefix = versionPrefix;
                    core.info(`Updated project version prefix to: ${projectBundleVersionPrefix}`);
                }
            }

            if (projectBundleVersionNumber <= lastVersionNumber) {
                projectBundleVersionNumber = lastVersionNumber + 1;
                core.info(`Auto Incremented bundle version ==> ${versionPrefix}${projectBundleVersionNumber}`);
            }

            infoPlist['CFBundleVersion'] = projectBundleVersionPrefix + projectBundleVersionNumber.toString();
            projectRef.bundleVersion = projectBundleVersionPrefix + projectBundleVersionNumber.toString();

            try {
                await fs.promises.writeFile(infoPlistPath, plist.build(infoPlist));
            } catch (error) {
                log(`Failed to update Info.plist!\n${error}`, 'error');
            }
        }
    } else {
        if (projectRef.platform === 'macOS') {
            const notarizeInput = core.getInput('notarize') || 'true';

            core.debug(`Notarize input: ${notarizeInput}`);
            projectRef.notarize =
                notarizeInput === 'true' ||
                projectRef.isSteamBuild ||
                projectRef.archiveType === 'pkg' ||
                projectRef.archiveType === 'dmg';
            let output = '';

            await exec('security', [
                'find-identity',
                '-v', projectRef.credential.keychainPath
            ], {
                listeners: {
                    stdout: (data: Buffer) => {
                        output += data.toString();
                    }
                },
                silent: true
            });

            if (!output.includes('Developer ID Application')) {
                throw new Error('Developer ID Application not found! developer-id-application-certificate input is required for notarization.');
            }

            if (projectRef.archiveType === 'pkg' || projectRef.archiveType === 'dmg') {
                if (!output.includes('Developer ID Installer')) {
                    throw new Error('Developer ID Installer not found! developer-id-installer-certificate input is required for notarization.');
                }
            }
        }
    }

    infoPlistContent = await getFileContents(infoPlistPath);
    return projectRef;
}

async function getSupportedPlatform(projectPath: string): Promise<string> {
    const projectFilePath = `${projectPath}/project.pbxproj`;
    core.debug(`.pbxproj file path: ${projectFilePath}`);
    await fs.promises.access(projectFilePath, fs.constants.R_OK);
    const content = await fs.promises.readFile(projectFilePath, 'utf8');
    const platformName = core.getInput('platform') || matchRegexPattern(content, /\s+SDKROOT = (?<platform>\w+)/, 'platform');

    if (!platformName) {
        throw new Error('Unable to determine the platform name from the build settings');
    }

    const platformMap = {
        'iphoneos': 'iOS',
        'macosx': 'macOS',
        'appletvos': 'tvOS',
        'watchos': 'watchOS',
        'xros': 'visionOS'
    };

    return platformMap[platformName];
}

async function getDestination(projectPath: string, scheme: string, platform: string): Promise<string> {
    // list all the destinations for the scheme for the developer in case they need it
    await execXcodeBuild([
        '-project', projectPath,
        '-scheme', scheme,
        '-showdestinations',
        '-json'
    ]);

    // if no specified destination set by developer, use generic platform destination
    const destinationInput = core.getInput('destination');

    if (destinationInput) {
        return destinationInput;
    } else {
        return `generic/platform=${platform}`;
    }
}

async function getBuildSettings(projectPath: string): Promise<string> {
    return await execXcodeBuild([
        'build',
        '-project', projectPath,
        '-showBuildSettings'
    ]);
}

function getBundleId(buildSettingsOutput: string) {
    const bundleId = core.getInput('bundle-id') || matchRegexPattern(buildSettingsOutput, /\s+PRODUCT_BUNDLE_IDENTIFIER = (?<bundleId>[\w.-]+)/, 'bundleId');

    if (!bundleId || bundleId === 'NO') {
        throw new Error('Unable to determine the bundle ID from the build settings');
    }

    return bundleId;
}

async function getPlatformSdkVersion(buildSettingsOutput: string): Promise<string> {
    let platformSdkVersion = core.getInput('platform-sdk-version');

    if (!platformSdkVersion) {
        platformSdkVersion = matchRegexPattern(buildSettingsOutput, /\s+SDK_VERSION = (?<sdkVersion>[\d.]+)/, 'sdkVersion');

        if (!platformSdkVersion) {
            throw new Error('Unable to determine the SDK version from the project file');
        }
    }

    core.info(`Platform SDK version: ${platformSdkVersion}`);
    return platformSdkVersion;
}

type SdkInfo = {
    canonicalName: string;
    displayName: string;
    isBaseSdk: boolean;
    platform: string;
    platformPath: string;
    platformVersion: string;
    sdkPath: string;
    sdkVersion: string;
}

async function getSdkInfo(platform: string, version: string): Promise<SdkInfo | null> {
    const output = await execXcodeBuild(['-showsdks', '-json']);
    core.debug(`Installed SDKs:\n${output}`);
    const installedSdks = JSON.parse(output) as Array<SdkInfo>;
    const platformMap = {
        'iOS': 'iphoneos',
        'macOS': 'macosx',
        'tvOS': 'appletvos',
        'watchOS': 'watchos',
        'visionOS': 'xros'
    };
    const sdk = installedSdks.find(sdk => sdk.platform.toLowerCase() === platformMap[platform] && sdk.sdkVersion.toString() === version);
    core.info(`Found SDK:\n${sdk ? JSON.stringify(sdk, null, 2) : ''}`);
    return sdk || null;
}

async function downloadPlatformAndSdk(platform: string, version: string): Promise<void> {
    const downloadDir = `${process.env.RUNNER_TEMP}/xcodes/${platform}-${version}`;
    await execXcodeBuild(['-downloadPlatform', platform, '-exportPath', downloadDir, '-buildVersion', version]);
    const dmgPaths = await getPathsWithGlob(`${downloadDir}/**/*.dmg`);

    core.info(`Downloaded DMG paths:\n${dmgPaths.join('\n')}`);

    for (const dmgPath of dmgPaths) {
        await fs.promises.access(dmgPath, fs.constants.R_OK);
        await execXcodeBuild(['-importPlatform', dmgPath]);
    }
}

async function getProjectScheme(projectPath: string): Promise<string> {
    let scheme = core.getInput('scheme');
    core.debug(`Scheme input: ${scheme}`);

    const projectInfoOutput = await execXcodeBuild(['-list', '-project', projectPath, `-json`]);
    const projectInfo = JSON.parse(projectInfoOutput);
    const schemes = projectInfo.project.schemes as string[];

    if (!schemes) {
        throw new Error('No schemes found in the project');
    }

    core.info(`Available Schemes:`);
    schemes.forEach(s => core.info(`  > ${s}`));

    if (!scheme) {
        if (schemes.includes('Unity-iPhone')) {
            scheme = 'Unity-iPhone';
        } else if (schemes.includes('Unity-VisionOS')) {
            scheme = 'Unity-VisionOS';
        } else {
            const excludedSchemes = ['GameAssembly', 'UnityFramework', 'Pods'];
            scheme = schemes.find(s => !excludedSchemes.includes(s) && !s.includes('Test'));
        }
    }

    if (!scheme) {
        throw new Error('Unable to determine the scheme to build');
    }

    core.info(`Scheme: ${scheme}`);
    return scheme;
}

async function getExportOptions(projectRef: XcodeProject): Promise<void> {
    const exportOptionPlistInput = core.getInput('export-option-plist');
    let exportOptionsPath = undefined;
    if (!exportOptionPlistInput) {
        const exportOption = core.getInput('export-option') || 'development';
        let method: string;
        if (projectRef.platform === 'macOS') {
            const archiveType = core.getInput('archive-type') || 'app';
            projectRef.archiveType = archiveType;
            switch (exportOption) {
                case 'steam':
                    method = 'developer-id';
                    projectRef.isSteamBuild = true;
                    projectRef.archiveType = 'app';
                    break;
                case 'ad-hoc':
                    method = 'development';
                    break;
                default:
                    method = exportOption;
                    break;
            }
            core.info(`Export Archive type: ${archiveType}`);
        } else {
            // revert back to development just in case user passes in steam for non-macos platforms
            if (exportOption === 'steam') {
                method = 'development';
            } else {
                method = exportOption;
            }
        }
        // As of Xcode 15.4, the old export methods 'app-store', 'ad-hoc', and 'development' are now deprecated.
        // The new equivalents are 'app-store-connect', 'release-testing', and 'debugging'.
        const xcodeMinVersion = semver.coerce('15.4');
        if (semver.gte(projectRef.xcodeVersion, xcodeMinVersion)) {
            switch (method) {
                case 'app-store':
                    method = 'app-store-connect';
                    break;
                case 'ad-hoc':
                    method = 'release-testing';
                    break;
                case 'development':
                    method = 'debugging';
                    break;
            }
        }
        const exportOptions = {
            method: method,
            signingStyle: projectRef.credential.manualSigningIdentity ? 'manual' : 'automatic',
            teamID: `${projectRef.credential.teamId}`
        };
        if (method === 'app-store-connect' && projectRef.autoIncrementBuildNumber) {
            exportOptions['manageAppVersionAndBuildNumber'] = true;
        }
        projectRef.exportOption = method;
        exportOptionsPath = `${projectRef.projectPath}/exportOptions.plist`;
        await fs.promises.writeFile(exportOptionsPath, plist.build(exportOptions));
    } else {
        exportOptionsPath = exportOptionPlistInput;
    }
    core.info(`Export options path: ${exportOptionsPath}`);

    if (!exportOptionsPath) {
        throw new Error(`Invalid path for export-option-plist: ${exportOptionsPath}`);
    }

    await getFileContents(exportOptionsPath);

    projectRef.exportOptionsPath = exportOptionsPath;
}

async function getDefaultEntitlementsMacOS(projectRef: XcodeProject): Promise<string> {
    const entitlementsPath = `${projectRef.projectPath}/Entitlements.plist`;
    try {
        await fs.promises.access(entitlementsPath, fs.constants.R_OK);
        core.info(`Existing Entitlements.plist found at: ${entitlementsPath}`);
        return entitlementsPath;
    } catch (error) {
        core.info(`Creating default entitlements at ${entitlementsPath}...`);
    }
    const exportOption = projectRef.exportOption;
    let defaultEntitlements = undefined;
    switch (exportOption) {
        case 'app-store':
        case 'app-store-connect':
            defaultEntitlements = {
                'com.apple.security.app-sandbox': true,
            };
            break;
        default:
            // use default hardened runtime entitlements
            defaultEntitlements = {
                'com.apple.security.cs.allow-jit': true,
                'com.apple.security.cs.allow-unsigned-executable-memory': true,
                'com.apple.security.cs.allow-dyld-environment-variables': true,
                'com.apple.security.cs.disable-library-validation': true,
                'com.apple.security.cs.disable-executable-page-protection': true,
            };
            break;
    }
    await fs.promises.writeFile(entitlementsPath, plist.build(defaultEntitlements));
    return entitlementsPath;
}

export async function ArchiveXcodeProject(projectRef: XcodeProject): Promise<XcodeProject> {
    const {
        projectPath,
        scheme,
        configuration,
        destination,
        platform,
        archivePath,
        entitlementsPath
    } = projectRef;
    const {
        teamId,
        manualSigningIdentity,
        manualProvisioningProfileUUID,
        keychainPath,
        appStoreConnectIssuerId,
        appStoreConnectKeyId,
        appStoreConnectKeyPath
    } = projectRef.credential;

    core.debug(`Archive path: ${archivePath}`);
    const archiveArgs = [
        'archive',
        '-project', projectPath,
        '-scheme', scheme,
        '-destination', destination,
        '-configuration', configuration,
        '-archivePath', archivePath,
        `-authenticationKeyID`, appStoreConnectKeyId,
        `-authenticationKeyPath`, appStoreConnectKeyPath,
        `-authenticationKeyIssuerID`, appStoreConnectIssuerId
    ];
    if (teamId) {
        archiveArgs.push(`DEVELOPMENT_TEAM=${teamId}`);
    }
    if (manualSigningIdentity) {
        archiveArgs.push(
            `CODE_SIGN_IDENTITY=${manualSigningIdentity}`,
            `EXPANDED_CODE_SIGN_IDENTITY=${manualSigningIdentity}`,
            `OTHER_CODE_SIGN_FLAGS=--keychain ${keychainPath}`
        );
    } else {
        archiveArgs.push(
            `CODE_SIGN_IDENTITY=-`,
            `EXPANDED_CODE_SIGN_IDENTITY=-`
        );
    }
    archiveArgs.push(
        `CODE_SIGN_STYLE=${manualProvisioningProfileUUID || manualSigningIdentity ? 'Manual' : 'Automatic'}`
    );
    if (manualProvisioningProfileUUID) {
        archiveArgs.push(`PROVISIONING_PROFILE=${manualProvisioningProfileUUID}`);
    } else {
        archiveArgs.push(
            `AD_HOC_CODE_SIGNING_ALLOWED=YES`,
            `-allowProvisioningUpdates`
        );
    }
    if (entitlementsPath) {
        archiveArgs.push(`CODE_SIGN_ENTITLEMENTS=${entitlementsPath}`);
    }
    if (platform === 'iOS') {
        archiveArgs.push('COPY_PHASE_STRIP=NO');
    }
    if (platform === 'macOS' && !projectRef.isAppStoreUpload()) {
        archiveArgs.push('ENABLE_HARDENED_RUNTIME=YES');
    }
    if (!core.isDebug()) {
        archiveArgs.push('-quiet');
    } else {
        archiveArgs.push('-verbose');
    }
    if (core.isDebug()) {
        await execXcodeBuild(archiveArgs);
    } else {
        await execWithXcBeautify(archiveArgs);
    }
    projectRef.archivePath = archivePath
    return projectRef;
}

export async function ExportXcodeArchive(projectRef: XcodeProject): Promise<XcodeProject> {
    const {
        platform,
        notarize,
        isSteamBuild,
        archiveType,
        archivePath,
        exportOptionsPath,
        exportPath
    } = projectRef;
    const {
        manualProvisioningProfileUUID,
        appStoreConnectIssuerId,
        appStoreConnectKeyId,
        appStoreConnectKeyPath
    } = projectRef.credential;

    core.debug(`Export path: ${exportPath}`);
    core.setOutput('output-directory', exportPath);
    const exportArgs = [
        '-exportArchive',
        '-archivePath', archivePath,
        '-exportPath', exportPath,
        '-exportOptionsPlist', exportOptionsPath,
        `-authenticationKeyID`, appStoreConnectKeyId,
        `-authenticationKeyPath`, appStoreConnectKeyPath,
        `-authenticationKeyIssuerID`, appStoreConnectIssuerId
    ];
    if (!manualProvisioningProfileUUID) {
        exportArgs.push(`-allowProvisioningUpdates`);
    }
    if (!core.isDebug()) {
        exportArgs.push('-quiet');
    } else {
        exportArgs.push('-verbose');
    }
    if (core.isDebug()) {
        await execXcodeBuild(exportArgs);
    } else {
        await execWithXcBeautify(exportArgs);
    }
    if (platform === 'macOS') {
        if (!projectRef.isAppStoreUpload()) {
            projectRef.executablePath = await getFirstPathWithGlob(`${exportPath}/**/*.app`);
            if (notarize) {
                await signMacOSAppBundle(projectRef);
                if (isSteamBuild) {
                    const isNotarized = await isAppBundleNotarized(projectRef.executablePath);
                    if (!isNotarized) {
                        const zipPath = path.join(exportPath, projectRef.executablePath.replace('.app', '.zip'));
                        await exec('ditto', ['-c', '-k', '--sequesterRsrc', '--keepParent', projectRef.executablePath, zipPath]);
                        await notarizeArchive(projectRef, zipPath, projectRef.executablePath);
                    }
                } else if (archiveType === 'pkg') {
                    projectRef.executablePath = await createMacOSInstallerPkg(projectRef);
                } else if (archiveType === 'dmg') {
                    throw new Error('DMG export is not supported yet!');
                } else {
                    throw new Error(`Invalid archive type: ${archiveType}`);
                }
            }
        }
        else {
            projectRef.executablePath = await getFirstPathWithGlob(`${projectRef.exportPath}/**/*.pkg`);
        }
    } else {
        projectRef.executablePath = await getFirstPathWithGlob(`${projectRef.exportPath}/**/*.ipa`);
    }
    try {
        await fs.promises.access(projectRef.executablePath, fs.constants.R_OK);
    } catch (error) {
        throw new Error(`Failed to export the archive at: ${projectRef.executablePath}`);
    }
    core.debug(`Exported executable: ${projectRef.executablePath}`);
    core.setOutput('executable', projectRef.executablePath);
    return projectRef;
}

async function isAppBundleNotarized(appPath: string): Promise<boolean> {
    let output = '';
    if (!core.isDebug()) {
        core.info(`[command]stapler validate ${appPath}`);
    }
    await exec('stapler', ['validate', appPath], {
        silent: !core.isDebug(),
        listeners: {
            stdout: (data: Buffer) => { output += data.toString(); }
        },
        ignoreReturnCode: true
    });
    if (output.includes('The validate action worked!')) {
        return true;
    }
    if (output.includes('does not have a ticket stapled to it')) {
        return false;
    }
    throw new Error(`Failed to validate the notarization ticket!\n${output}`);
}

async function signMacOSAppBundle(projectRef: XcodeProject): Promise<void> {
    const appPath = await getFirstPathWithGlob(`${projectRef.exportPath}/**/*.app`);
    await fs.promises.access(appPath, fs.constants.R_OK);
    const stat = await fs.promises.stat(appPath);
    if (!stat.isDirectory()) {
        throw new Error(`Not a valid app bundle: ${appPath}`);
    }
    await exec('xattr', ['-cr', appPath]);
    let findSigningIdentityOutput = '';
    const findSigningIdentityExitCode = await exec('security', [
        'find-identity',
        '-p', 'codesigning',
        '-v', projectRef.credential.keychainPath
    ], {
        listeners: {
            stdout: (data: Buffer) => {
                findSigningIdentityOutput += data.toString();
            }
        },
        ignoreReturnCode: true
    });
    if (findSigningIdentityExitCode !== 0) {
        log(findSigningIdentityOutput, 'error');
        throw new Error(`Failed to find the signing identity!`);
    }
    const matches = findSigningIdentityOutput.matchAll(/\d\) (?<uuid>\w+) \"(?<signing_identity>[^"]+)\"$/gm);
    const signingIdentities = Array.from(matches).map(match => ({
        uuid: match.groups?.['uuid'],
        signing_identity: match.groups?.['signing_identity']
    })).filter(identity => identity.signing_identity.includes('Developer ID Application'));
    if (signingIdentities.length === 0) {
        throw new Error(`Failed to find the signing identity!`);
    }
    const developerIdApplicationSigningIdentity = signingIdentities[0].signing_identity;
    if (!developerIdApplicationSigningIdentity) {
        throw new Error(`Failed to find the Developer ID Application signing identity!`);
    }
    if (projectRef.entitlementsPath) {
        if (projectRef.entitlementsPath.trim().length === 0) {
            throw new Error(`Entitlements path is empty!`);
        }
        if (!fs.existsSync(projectRef.entitlementsPath)) {
            throw new Error(`Entitlements file not found at: ${projectRef.entitlementsPath}`);
        }
    } else {
        throw new Error(`Entitlements path is not set! Please provide a valid entitlements plist file.`);
    }
    const codesignArgs = [
        '--force',
        '--verify',
        '--timestamp',
        '--options', 'runtime',
        '--keychain', projectRef.credential.keychainPath,
        '--sign', developerIdApplicationSigningIdentity,
        '--entitlements', projectRef.entitlementsPath,
    ];
    if (core.isDebug()) {
        codesignArgs.unshift('--verbose');
    }
    await exec('find', [
        appPath,
        '-name', '*.bundle',
        '-exec', 'find', '{}', '-name', '*.meta', '-delete', ';',
        '-exec', 'codesign', ...codesignArgs, '{}', ';'
    ]);
    await exec('find', [
        appPath,
        '-name', '*.dylib',
        '-exec', 'codesign', ...codesignArgs, '{}', ';'
    ]);
    await exec('codesign', [
        '--deep',
        ...codesignArgs,
        appPath
    ]);
    const verifyExitCode = await exec('codesign', [
        '--verify',
        '--deep',
        '--strict',
        '--verbose=2',
        '--keychain', projectRef.credential.keychainPath,
        appPath
    ], { ignoreReturnCode: true });
    if (verifyExitCode !== 0) {
        throw new Error('App bundle codesign verification failed!');
    }
    let entitlementsOutput = '';
    const entitlementsExitCode = await exec('codesign', [
        '--display',
        '--entitlements', '-', '--xml',
        appPath
    ], {
        listeners: {
            stdout: (data: Buffer) => {
                entitlementsOutput += data.toString();
            }
        },
        ignoreReturnCode: true
    });
    if (entitlementsExitCode !== 0) {
        log(entitlementsOutput, 'error');
        throw new Error('Failed to display signed entitlements!');
    }
    const expectedEntitlementsContent = await fs.promises.readFile(projectRef.entitlementsPath, 'utf8');
    const expectedEntitlements = plist.parse(expectedEntitlementsContent);
    if (!entitlementsOutput.trim()) {
        throw new Error('Signed entitlements output is empty!');
    }
    const signedEntitlements = plist.parse(entitlementsOutput);
    if (!DeepEqual(expectedEntitlements, signedEntitlements)) {
        throw new Error('Signed entitlements do not match the expected entitlements!');
    }
}

async function createMacOSInstallerPkg(projectRef: XcodeProject): Promise<string> {
    core.info('Creating macOS installer pkg...');
    let output = '';
    const pkgPath = `${projectRef.exportPath}/${projectRef.projectName}.pkg`;
    const appPath = await getFirstPathWithGlob(`${projectRef.exportPath}/**/*.app`);
    const productBuildExitCode = await exec('xcrun', [
        'productbuild',
        '--component',
        appPath, '/Applications',
        pkgPath
    ], {
        listeners: {
            stdout: (data: Buffer) => {
                output += data.toString();
            }
        },
        ignoreReturnCode: true
    });
    if (productBuildExitCode !== 0) {
        log(output, 'error');
        throw new Error(`Failed to create the pkg!`);
    }
    try {
        await fs.promises.access(pkgPath, fs.constants.R_OK);
    } catch (error) {
        throw new Error(`Failed to create the pkg at: ${pkgPath}!`);
    }
    let findSigningIdentityOutput = '';
    const findSigningIdentityExitCode = await exec('security', [
        'find-identity',
        '-v', projectRef.credential.keychainPath
    ], {
        listeners: {
            stdout: (data: Buffer) => {
                findSigningIdentityOutput += data.toString();
            }
        },
        ignoreReturnCode: true
    });
    if (findSigningIdentityExitCode !== 0) {
        log(findSigningIdentityOutput, 'error');
        throw new Error(`Failed to get the signing identity!`);
    }
    const matches = findSigningIdentityOutput.matchAll(/\d\) (?<uuid>\w+) \"(?<signing_identity>[^"]+)\"$/gm);
    const signingIdentities = Array.from(matches).map(match => ({
        uuid: match.groups?.['uuid'],
        signing_identity: match.groups?.['signing_identity']
    })).filter(identity => identity.signing_identity.includes('Developer ID Installer'));
    if (signingIdentities.length === 0) {
        throw new Error(`Failed to find the signing identity!`);
    }
    const developerIdInstallerSigningIdentity = signingIdentities[0].signing_identity;
    if (!developerIdInstallerSigningIdentity) {
        throw new Error(`Failed to find the Developer ID Installer signing identity!`);
    }
    const signedPkgPath = pkgPath.replace('.pkg', '-signed.pkg');
    await exec('xcrun', [
        'productsign',
        '--sign', developerIdInstallerSigningIdentity,
        '--keychain', projectRef.credential.keychainPath,
        pkgPath,
        signedPkgPath
    ]);
    await exec('pkgutil', ['--check-signature', signedPkgPath]);
    await fs.promises.unlink(pkgPath);
    await fs.promises.rename(signedPkgPath, pkgPath);
    await notarizeArchive(projectRef, pkgPath, pkgPath);
    return pkgPath;
}

async function notarizeArchive(projectRef: XcodeProject, archivePath: string, staplePath: string): Promise<void> {
    const notarizeArgs = [
        'notarytool',
        'submit',
        '--key', projectRef.credential.appStoreConnectKeyPath,
        '--key-id', projectRef.credential.appStoreConnectKeyId,
        '--issuer', projectRef.credential.appStoreConnectIssuerId,
        '--team-id', projectRef.credential.teamId,
        '--wait',
        '--no-progress',
        '--output-format', 'json',
    ];
    if (core.isDebug()) {
        notarizeArgs.push('--verbose');
    } else {
        core.info(`[command]${xcrun} ${notarizeArgs.join(' ')} ${archivePath}`);
    }
    let notarizeOutput = '';
    const notarizeExitCode = await exec(xcrun, [...notarizeArgs, archivePath], {
        silent: !core.isDebug(),
        listeners: {
            stdout: (data: Buffer) => {
                notarizeOutput += data.toString();
            }
        },
        ignoreReturnCode: true
    });
    if (notarizeExitCode !== 0) {
        log(notarizeOutput, 'error');
        throw new Error(`Failed to notarize the app!`);
    }
    log(notarizeOutput);
    const notaryResult = JSON.parse(notarizeOutput);
    if (notaryResult.status !== 'Accepted') {
        const notaryLogs = await getNotarizationLog(projectRef, notaryResult.id);
        throw new Error(`Notarization failed! Status: ${notaryResult.status}\n${notaryLogs}`);
    }
    const stapleArgs = [
        'stapler',
        'staple',
        staplePath,
    ];
    if (core.isDebug()) {
        stapleArgs.push('--verbose');
    } else {
        core.info(`[command]${xcrun} ${stapleArgs.join(' ')}`);
    }
    let stapleOutput = '';
    const stapleExitCode = await exec(xcrun, stapleArgs, {
        silent: !core.isDebug(),
        listeners: {
            stdout: (data: Buffer) => {
                stapleOutput += data.toString();
            }
        },
        ignoreReturnCode: true
    });
    if (stapleExitCode !== 0) {
        log(stapleOutput, 'error');
        throw new Error(`Failed to staple the notarization ticket!`);
    }
    log(stapleOutput);
    if (!stapleOutput.includes('The staple and validate action worked!')) {
        throw new Error(`Failed to staple the notarization ticket!\n${stapleOutput}`);
    }
    const notarization = await isAppBundleNotarized(staplePath);
    if (!notarization) {
        throw new Error(`Failed to notarize the app bundle!`);
    }
}

async function getNotarizationLog(projectRef: XcodeProject, id: string): Promise<void> {
    let output = '';
    const notaryLogArgs = [
        'notarytool',
        'log', id,
        '--key', projectRef.credential.appStoreConnectKeyPath,
        '--key-id', projectRef.credential.appStoreConnectKeyId,
        '--issuer', projectRef.credential.appStoreConnectIssuerId,
        '--team-id', projectRef.credential.teamId,
    ];
    if (core.isDebug()) {
        notaryLogArgs.push('--verbose');
    }
    const logExitCode = await exec(xcrun, notaryLogArgs, {
        listeners: {
            stdout: (data: Buffer) => {
                output += data.toString();
            }
        },
        ignoreReturnCode: true
    });
    if (logExitCode !== 0) {
        throw new Error(`Failed to get notarization log!`);
    }
}

async function execXcodeBuild(xcodeBuildArgs: string[]): Promise<string> {
    let exitCode: number = 1;
    let output: string = '';

    if (!core.isDebug()) {
        core.startGroup(`[command]${xcodebuild} ${xcodeBuildArgs.join(' ')}`);
    }

    try {
        exitCode = await exec(xcodebuild, xcodeBuildArgs, {
            listeners: {
                stdline(data: string) {
                    output += data + '\n';

                    if (!core.isDebug()) {
                        core.info(data);
                    }
                },
                errline(data: string) {
                    output += data + '\n';

                    if (!core.isDebug()) {
                        core.error(data);
                    }
                }
            },
            silent: !core.isDebug(),
            ignoreReturnCode: true
        });

        // if (!core.isDebug()) {
        //     core.info(output);
        // }

        await parseBundleLog(output);
    } finally {
        core.endGroup();
    }

    if (exitCode !== 0) {
        throw new Error(`xcodebuild exited with code: ${exitCode}`);
    }

    return output;
}

async function execWithXcBeautify(xcodeBuildArgs: string[]) {
    try {
        await exec('xcbeautify', ['--version'], { silent: true });
    } catch (error) {
        core.debug('Installing xcbeautify...');
        await exec('brew', ['install', 'xcbeautify']);
    }
    const beautifyArgs = ['--quiet', '--is-ci', '--disable-logging'];
    const xcBeautifyProcess = spawn('xcbeautify', beautifyArgs, {
        stdio: ['pipe', process.stdout, process.stderr]
    });
    core.info(`[command]${xcodebuild} ${xcodeBuildArgs.join(' ')}`);
    let errorOutput = '';
    const exitCode = await exec(xcodebuild, xcodeBuildArgs, {
        listeners: {
            stdout: (data: Buffer) => {
                xcBeautifyProcess.stdin.write(data);
            },
            stderr: (data: Buffer) => {
                xcBeautifyProcess.stdin.write(data);
                errorOutput += data.toString();
            }
        },
        silent: true,
        ignoreReturnCode: true
    });
    xcBeautifyProcess.stdin.end();
    await new Promise<void>((resolve, reject) => {
        xcBeautifyProcess.stdin.on('finish', () => {
            xcBeautifyProcess.on('close', (code) => {
                if (code !== 0) {
                    reject(new Error(`xcbeautify exited with code ${code}`));
                } else {
                    resolve();
                }
            });
        });
    });
    if (exitCode !== 0) {
        log(`xcodebuild error: ${errorOutput}`, 'error');
        await parseBundleLog(errorOutput);
        throw new Error(`xcodebuild exited with code: ${exitCode}`);
    }
}

async function parseBundleLog(errorOutput: string) {
    const logFilePathMatch = errorOutput.match(/_createLoggingBundleAtPath:.*Created bundle at path "([^"]+)"/);
    if (!logFilePathMatch) { return; }
    const logFilePath = logFilePathMatch[1];
    log(`Log file path: ${logFilePath}`, 'info');
    try {
        await fs.promises.access(logFilePath, fs.constants.R_OK);
        const isDirectory = (await fs.promises.stat(logFilePath)).isDirectory();
        if (isDirectory) {
            // list all files in the directory
            const files = await fs.promises.readdir(logFilePath);
            log(`Log file is a directory. Files: ${files.join(', ')}`, 'info');
            return;
        }
        const logFileContent = await fs.promises.readFile(logFilePath, 'utf8');
        log(`----- Log content: -----\n${logFileContent}\n-----------------------------------`, 'info');
    } catch (error) {
        log(`Error reading log file: ${error.message}`, 'error');
    }
}

export async function ValidateApp(projectRef: XcodeProject) {
    const platforms = {
        'iOS': 'ios',
        'macOS': 'macos',
        'tvOS': 'appletvos',
        'visionOS': 'xros'
    };
    try {
        await fs.promises.access(projectRef.executablePath, fs.constants.R_OK);
    } catch (error) {
        throw new Error(`Failed to access the executable at: ${projectRef.executablePath}`);
    }
    const validateArgs = [
        'altool',
        '--validate-app',
        '--bundle-id', projectRef.bundleId,
        '--file', projectRef.executablePath,
        '--type', platforms[projectRef.platform],
        '--apiKey', projectRef.credential.appStoreConnectKeyId,
        '--apiIssuer', projectRef.credential.appStoreConnectIssuerId,
        '--output-format', 'json'
    ];
    if (!core.isDebug()) {
        core.info(`[command]${xcrun} ${validateArgs.join(' ')}`);
    } else {
        validateArgs.push('--verbose');
    }
    let output = '';
    const exitCode = await exec(xcrun, validateArgs, {
        listeners: {
            stdout: (data: Buffer) => {
                output += data.toString();
            }
        },
        silent: !core.isDebug(),
        ignoreReturnCode: true
    });
    if (exitCode > 0) {
        throw new Error(`Failed to validate app: ${JSON.stringify(JSON.parse(output), null, 2)}`);
    }
}

export async function UploadApp(projectRef: XcodeProject) {
    const platforms = {
        'iOS': 'ios',
        'macOS': 'macos',
        'tvOS': 'appletvos',
        'visionOS': 'xros'
    };
    const uploadArgs = [
        'altool',
        '--upload-package', projectRef.executablePath,
        '--type', platforms[projectRef.platform],
        '--apple-id', projectRef.appId,
        '--bundle-id', projectRef.bundleId,
        '--bundle-version', projectRef.bundleVersion,
        '--bundle-short-version-string', projectRef.versionString,
        '--apiKey', projectRef.credential.appStoreConnectKeyId,
        '--apiIssuer', projectRef.credential.appStoreConnectIssuerId,
        '--output-format', 'json'
    ];
    if (!core.isDebug()) {
        core.info(`[command]${xcrun} ${uploadArgs.join(' ')}`);
    } else {
        uploadArgs.push('--verbose');
    }
    let output = '';
    const exitCode = await exec(xcrun, uploadArgs, {
        listeners: {
            stdout: (data: Buffer) => {
                output += data.toString();
            }
        },
        silent: !core.isDebug(),
        ignoreReturnCode: true
    });
    const outputJson = JSON.stringify(JSON.parse(output), null, 2);
    if (exitCode !== 0) {
        log(outputJson, 'error');
        throw new Error(`Failed to upload app!`);
    }
    core.debug(outputJson);
    try {
        const whatsNew = await getWhatsNew();
        core.info(`\n--------------- what's new ---------------\n${whatsNew}\n------------------------------------------\n`);
        await UpdateTestDetails(projectRef, whatsNew);
    } catch (error) {
        log(`Failed to update test details!\n${error}`, 'error');
    }
}

async function getWhatsNew(): Promise<string> {
    let whatsNew = core.getInput('whats-new');
    if (!whatsNew || whatsNew.length === 0) {
        const head = github.context.eventName === 'pull_request'
            ? github.context.payload.pull_request?.head.sha
            : github.context.sha || 'HEAD';
        await execGit(['fetch', 'origin', head, '--depth=1']);
        const commitSha = await execGit(['log', head, '-1', '--format=%h']);
        const branchNameDetails = await execGit(['log', head, '-1', '--format=%d']);
        const branchNameMatch = branchNameDetails.match(/\((?<branch>.+)\)/);
        let branchName = '';
        if (branchNameMatch && branchNameMatch.groups) {
            branchName = branchNameMatch.groups.branch;
            if (branchName.includes(' -> ')) {
                branchName = branchName.split(' -> ')[1];
            }
            if (branchName.includes(',')) {
                branchName = branchName.split(',')[1];
            }
        }
        let pullRequestInfo = '';
        if (github.context.eventName === 'pull_request') {
            const prTitle = github.context.payload.pull_request?.title;
            pullRequestInfo = `PR #${github.context.payload.pull_request?.number} ${prTitle}`;
        }
        const commitMessage = await execGit(['log', head, '-1', '--format=%B']);
        whatsNew = `[${commitSha.trim()}] ${branchName.trim()}\n${pullRequestInfo}\n${commitMessage.trim()}`;
        if (whatsNew.length > 4000) {
            whatsNew = `${whatsNew.substring(0, 3997)}...`;
        }
    }
    if (whatsNew.length === 0) {
        throw new Error('Test details empty!');
    }
    return whatsNew;
}

async function execGit(args: string[]): Promise<string> {
    let output = '';
    if (!core.isDebug()) {
        core.info(`[command]git ${args.join(' ')}`);
    }
    const exitCode = await exec('git', args, {
        listeners: {
            stdout: (data: Buffer) => {
                output += data.toString();
            }
        },
        silent: !core.isDebug()
    });
    if (exitCode > 0) {
        log(output, 'error');
        throw new Error(`Git failed with exit code: ${exitCode}`);
    }
    return output;
}
