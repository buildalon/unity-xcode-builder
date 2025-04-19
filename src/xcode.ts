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
    GetLatestBundleVersion,
    UpdateTestDetails,
    UnauthorizedError,
    GetAppId
} from './AppStoreConnectClient';
import { log } from './utilities';
import core = require('@actions/core');
import { AppleCredential } from './AppleCredential';
import { SemVer } from 'semver';

const xcodebuild = '/usr/bin/xcodebuild';
const xcrun = '/usr/bin/xcrun';
const WORKSPACE = process.env.GITHUB_WORKSPACE || process.cwd();

export async function GetProjectDetails(credential: AppleCredential, xcodeVersion: SemVer): Promise<XcodeProject> {
    const projectPathInput = core.getInput('project-path') || `${WORKSPACE}/**/*.xcodeproj`;
    core.debug(`Project path input: ${projectPathInput}`);
    let projectPath = undefined;
    const globber = await glob.create(projectPathInput);
    const files = await globber.glob();
    const excludedProjects = ['GameAssembly', 'UnityFramework', 'Pods'];
    for (const file of files) {
        if (file.endsWith('.xcodeproj')) {
            const projectBaseName = path.basename(file, '.xcodeproj');
            if (excludedProjects.includes(projectBaseName)) {
                continue;
            }
            core.debug(`Found Xcode project: ${file}`);
            projectPath = file;
            break;
        }
    }
    if (!projectPath) {
        throw new Error('Invalid project-path! Unable to find .xcodeproj');
    }
    core.debug(`Resolved Project path: ${projectPath}`);
    await fs.promises.access(projectPath, fs.constants.R_OK);
    const projectDirectory = path.dirname(projectPath);
    core.info(`Project directory: ${projectDirectory}`);
    const projectName = path.basename(projectPath, '.xcodeproj');
    const scheme = await getProjectScheme(projectPath);
    const platform = await getSupportedPlatform(projectPath);
    core.info(`Platform: ${platform}`);
    if (!platform) {
        throw new Error('Unable to determine the platform to build for.');
    }
    if (platform !== 'macOS') {
        await checkSimulatorsAvailable(platform);
    }
    const destination = core.getInput('destination') || `generic/platform=${platform}`;
    core.debug(`Using destination: ${destination}`);
    const bundleId = await getBuildSettings(projectPath, scheme, platform, destination);
    core.info(`Bundle ID: ${bundleId}`);
    if (!bundleId) {
        throw new Error('Unable to determine the bundle ID');
    }
    let infoPlistPath = `${projectDirectory}/${projectName}/Info.plist`;
    if (!fs.existsSync(infoPlistPath)) {
        infoPlistPath = `${projectDirectory}/Info.plist`;
    }
    core.info(`Info.plist path: ${infoPlistPath}`);
    const infoPlistHandle = await fs.promises.open(infoPlistPath, fs.constants.O_RDWR);
    let infoPlistContent: string;
    try {
        infoPlistContent = await fs.promises.readFile(infoPlistHandle, 'utf8');
    } finally {
        await infoPlistHandle.close();
    }
    const infoPlist = plist.parse(infoPlistContent) as any;
    const cFBundleShortVersionString = infoPlist['CFBundleShortVersionString'];
    core.info(`CFBundleShortVersionString: ${cFBundleShortVersionString}`);
    const cFBundleVersion = infoPlist['CFBundleVersion'] as number;
    core.info(`CFBundleVersion: ${cFBundleVersion}`);
    const projectRef = new XcodeProject(
        projectPath,
        projectName,
        platform,
        destination,
        bundleId,
        projectDirectory,
        cFBundleShortVersionString,
        cFBundleVersion,
        scheme,
        credential,
        xcodeVersion
    );
    await getExportOptions(projectRef);
    if (projectRef.isAppStoreUpload() && core.getInput('auto-increment-build-number') === 'true') {
        projectRef.credential.appleId = await GetAppId(projectRef);
        let bundleVersion = -1;
        try {
            bundleVersion = await GetLatestBundleVersion(projectRef);
        } catch (error) {
            if (error instanceof UnauthorizedError) {
                throw error;
            }
        }
        if (projectRef.bundleVersion <= bundleVersion) {
            projectRef.bundleVersion = bundleVersion + 1;
            core.debug(`Auto Incremented bundle version ==> ${projectRef.bundleVersion}`);
            infoPlist['CFBundleVersion'] = projectRef.bundleVersion.toString();
            try {
                await fs.promises.writeFile(infoPlistPath, plist.build(infoPlist));
            } catch (error) {
                log(`Failed to update Info.plist!\n${error}`, 'error');
            }
            const plistHandle = await fs.promises.open(infoPlistPath, fs.constants.O_RDONLY);
            try {
                core.info(`Updated Info.plist with CFBundleVersion: ${projectRef.bundleVersion}`);
                infoPlistContent = await fs.promises.readFile(plistHandle, 'utf8');
            } finally {
                await plistHandle.close();
            }
        }
    }
    core.info(`----- Info.plist content: -----\n${infoPlistContent}\n-----------------------------------`);
    return projectRef;
}

async function checkSimulatorsAvailable(platform: string): Promise<void> {
    const destinationArgs = ['simctl', 'list', 'devices', '--json'];
    let output = '';
    if (!core.isDebug()) {
        core.info(`[command]${xcrun} ${destinationArgs.join(' ')}`);
    }
    await exec(xcrun, destinationArgs, {
        listeners: {
            stdout: (data: Buffer) => {
                output += data.toString();
            }
        },
        silent: !core.isDebug()
    });
    const response = JSON.parse(output);
    const devices = response.devices;
    const platformDevices = Object.keys(devices)
        .filter(key => key.toLowerCase().includes(platform.toLowerCase()))
        .flatMap(key => devices[key]);
    if (platformDevices.length > 0) {
        return;
    }
    await exec(xcodebuild, ['-downloadPlatform', platform]);
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

async function getBuildSettings(projectPath: string, scheme: string, platform: string, destination: string): Promise<string> {
    let buildSettingsOutput = '';
    const projectSettingsArgs = [
        'build',
        '-project', projectPath,
        '-scheme', scheme,
        '-destination', destination,
        '-showBuildSettings'
    ];
    if (!core.isDebug()) {
        core.info(`[command]${xcodebuild} ${projectSettingsArgs.join(' ')}`);
    }
    await exec(xcodebuild, projectSettingsArgs, {
        listeners: {
            stdout: (data: Buffer) => {
                buildSettingsOutput += data.toString();
            }
        },
        silent: !core.isDebug()
    });
    let platformSdkVersion = core.getInput('platform-sdk-version') || null;
    if (!platformSdkVersion) {
        platformSdkVersion = matchRegexPattern(buildSettingsOutput, /\s+SDK_VERSION = (?<sdkVersion>[\d.]+)/, 'sdkVersion') || null;
    }
    if (platform !== 'macOS') {
        await downloadPlatformSdkIfMissing(platform, platformSdkVersion);
    }
    const bundleId = core.getInput('bundle-id') || matchRegexPattern(buildSettingsOutput, /\s+PRODUCT_BUNDLE_IDENTIFIER = (?<bundleId>[\w.-]+)/, 'bundleId');
    if (!bundleId || bundleId === 'NO') {
        throw new Error('Unable to determine the bundle ID from the build settings');
    }
    return bundleId;
}

function matchRegexPattern(string: string, pattern: RegExp, group: string | null): string {
    const match = string.match(pattern);
    if (!match) {
        throw new Error(`Failed to resolve: ${pattern}`);
    }
    return group ? match.groups?.[group] : match[1];
}

async function getProjectScheme(projectPath: string): Promise<string> {
    let scheme = core.getInput('scheme');
    let projectInfoOutput = '';
    if (!core.isDebug()) {
        core.info(`[command]${xcodebuild} -list -project ${projectPath} -json`);
    }
    await exec(xcodebuild, ['-list', '-project', projectPath, `-json`], {
        listeners: {
            stdout: (data: Buffer) => {
                projectInfoOutput += data.toString();
            }
        },
        silent: !core.isDebug()
    });
    const projectInfo = JSON.parse(projectInfoOutput);
    const schemes = projectInfo.project.schemes as string[];
    if (!schemes) {
        throw new Error('No schemes found in the project');
    }
    core.debug(`Available schemes:`);
    schemes.forEach(s => core.debug(`  > ${s}`));
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
    core.debug(`Using scheme: ${scheme}`);
    return scheme;
}

async function downloadPlatformSdkIfMissing(platform: string, version: string | null) {
    if (core.isDebug()) {
        await exec('xcodes', ['runtimes']);
    }
    if (version) {
        await exec('xcodes', ['runtimes', 'install', `${platform} ${version}`]);
    }
}

export async function ArchiveXcodeProject(projectRef: XcodeProject): Promise<XcodeProject> {
    const { projectPath, projectName, projectDirectory } = projectRef;
    const archivePath = `${projectDirectory}/${projectName}.xcarchive`;
    core.debug(`Archive path: ${archivePath}`);
    const configuration = core.getInput('configuration') || 'Release';
    core.debug(`Configuration: ${configuration}`);
    let entitlementsPath = core.getInput('entitlements-plist');
    if (!entitlementsPath && projectRef.platform === 'macOS') {
        await getDefaultEntitlementsMacOS(projectRef);
    } else {
        projectRef.entitlementsPath = entitlementsPath;
    }
    const archiveArgs = [
        'archive',
        '-project', projectPath,
        '-scheme', projectRef.scheme,
        '-destination', projectRef.destination,
        '-configuration', configuration,
        '-archivePath', archivePath,
        `-authenticationKeyID`, projectRef.credential.appStoreConnectKeyId,
        `-authenticationKeyPath`, projectRef.credential.appStoreConnectKeyPath,
        `-authenticationKeyIssuerID`, projectRef.credential.appStoreConnectIssuerId,
    ];
    const { teamId, signingIdentity, provisioningProfileUUID, keychainPath } = projectRef.credential;
    if (teamId) {
        archiveArgs.push(`DEVELOPMENT_TEAM=${teamId}`);
    }
    if (signingIdentity) {
        archiveArgs.push(
            `CODE_SIGN_IDENTITY=${signingIdentity}`,
            `OTHER_CODE_SIGN_FLAGS=--keychain ${keychainPath}`
        );
    } else {
        archiveArgs.push(`CODE_SIGN_IDENTITY=-`);
    }
    archiveArgs.push(
        `CODE_SIGN_STYLE=${provisioningProfileUUID || signingIdentity ? 'Manual' : 'Automatic'}`
    );
    if (provisioningProfileUUID) {
        archiveArgs.push(`PROVISIONING_PROFILE=${provisioningProfileUUID}`);
    } else {
        archiveArgs.push(
            `AD_HOC_CODE_SIGNING_ALLOWED=YES`,
            `-allowProvisioningUpdates`
        );
    }
    if (projectRef.entitlementsPath) {
        core.debug(`Entitlements path: ${projectRef.entitlementsPath}`);
        const entitlementsHandle = await fs.promises.open(projectRef.entitlementsPath, fs.constants.O_RDONLY);
        try {
            const entitlementsContent = await fs.promises.readFile(entitlementsHandle, 'utf8');
            core.debug(`----- Entitlements content: -----\n${entitlementsContent}\n-----------------------------------`);
        } finally {
            await entitlementsHandle.close();
        }
        archiveArgs.push(`CODE_SIGN_ENTITLEMENTS=${projectRef.entitlementsPath}`);
    }
    if (projectRef.platform === 'iOS') {
        // don't strip debug symbols during copy
        archiveArgs.push('COPY_PHASE_STRIP=NO');
    }
    if (projectRef.platform === 'macOS' && !projectRef.isAppStoreUpload()) {
        // enable hardened runtime
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
    const { projectName, projectDirectory, archivePath, exportOptionsPath } = projectRef;
    projectRef.exportPath = `${projectDirectory}/${projectName}`;
    core.debug(`Export path: ${projectRef.exportPath}`);
    core.setOutput('output-directory', projectRef.exportPath);
    const exportArgs = [
        '-exportArchive',
        '-archivePath', archivePath,
        '-exportPath', projectRef.exportPath,
        '-exportOptionsPlist', exportOptionsPath,
        '-allowProvisioningUpdates',
        `-authenticationKeyID`, projectRef.credential.appStoreConnectKeyId,
        `-authenticationKeyPath`, projectRef.credential.appStoreConnectKeyPath,
        `-authenticationKeyIssuerID`, projectRef.credential.appStoreConnectIssuerId
    ];
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
    if (projectRef.platform === 'macOS') {
        if (!projectRef.isAppStoreUpload()) {
            const notarizeInput = core.getInput('notarize') || 'true'
            const notarize = notarizeInput === 'true';
            core.debug(`Notarize? ${notarize}`);
            if (notarize) {
                projectRef.executablePath = await createMacOSInstallerPkg(projectRef);
            } else {
                projectRef.executablePath = await getFileAtGlobPath(`${projectRef.exportPath}/**/*.app`);
            }
        }
        else {
            projectRef.executablePath = await getFileAtGlobPath(`${projectRef.exportPath}/**/*.pkg`);
        }
    } else {
        projectRef.executablePath = await getFileAtGlobPath(`${projectRef.exportPath}/**/*.ipa`);
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

async function getFileAtGlobPath(globPattern: string): Promise<string> {
    const globber = await glob.create(globPattern);
    const files = await globber.glob();
    if (files.length === 0) {
        throw new Error(`No file found at: ${globPattern}`);
    }
    return files[0];
}

async function createMacOSInstallerPkg(projectRef: XcodeProject): Promise<string> {
    core.info('Creating macOS installer pkg...');
    let output = '';
    const pkgPath = `${projectRef.exportPath}/${projectRef.projectName}.pkg`;
    const appPath = await getFileAtGlobPath(`${projectRef.exportPath}/**/*.app`);
    await exec('productbuild', ['--component', appPath, '/Applications', pkgPath], {
        listeners: {
            stdout: (data: Buffer) => {
                output += data.toString();
            }
        }
    });
    try {
        await fs.promises.access(pkgPath, fs.constants.R_OK);
    } catch (error) {
        throw new Error(`Failed to create the pkg at: ${pkgPath}!`);
    }
    return pkgPath;
}

async function getExportOptions(projectRef: XcodeProject): Promise<void> {
    const exportOptionPlistInput = core.getInput('export-option-plist');
    let exportOptionsPath = undefined;
    if (!exportOptionPlistInput) {
        const exportOption = core.getInput('export-option') || 'development';
        let method: string;
        if (projectRef.platform === 'macOS') {
            switch (exportOption) {
                case 'steam':
                    method = 'developer-id';
                    break;
                case 'ad-hoc':
                    method = 'development';
                    break;
                default:
                    method = exportOption;
                    break;
            }
        } else {
            method = exportOption;
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
            signingStyle: projectRef.credential.signingIdentity ? 'manual' : 'automatic',
            teamID: `${projectRef.credential.teamId}`
        };
        if (method === 'app-store-connect') {
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
    const exportOptionsHandle = await fs.promises.open(exportOptionsPath, fs.constants.O_RDONLY);
    try {
        const exportOptionContent = await fs.promises.readFile(exportOptionsHandle, 'utf8');
        core.info(`----- Export options content: -----\n${exportOptionContent}\n-----------------------------------`);
        const exportOptions = plist.parse(exportOptionContent);
        projectRef.exportOption = exportOptions['method'];
    } finally {
        await exportOptionsHandle.close();
    }
    projectRef.exportOptionsPath = exportOptionsPath;
}

async function getDefaultEntitlementsMacOS(projectRef: XcodeProject): Promise<void> {
    const entitlementsPath = `${projectRef.projectPath}/Entitlements.plist`;
    projectRef.entitlementsPath = entitlementsPath;
    try {
        await fs.promises.access(entitlementsPath, fs.constants.R_OK);
        core.debug(`Existing Entitlements.plist found at: ${entitlementsPath}`);
        return;
    } catch (error) {
        core.warning('Entitlements.plist not found, creating default Entitlements.plist...');
    }
    const exportOption = projectRef.exportOption;
    let defaultEntitlements = undefined;
    // https://yemi.me/2020/02/17/en/submit-unity-macos-build-to-steam-appstore/#CodeSigning
    switch (exportOption) {
        case 'app-store':
        case 'app-store-connect':
            defaultEntitlements = {
                'com.apple.security.app-sandbox': true,
                'com.apple.security.files.user-selected.read-only': true,
            };
            break;
        default:
            // steam: https://partner.steamgames.com/doc/store/application/platforms#3
            defaultEntitlements = {
                'com.apple.security.cs.disable-library-validation': true,
                'com.apple.security.cs.allow-dyld-environment-variables': true,
                'com.apple.security.cs.disable-executable-page-protection': true,
            };
            break;
    }
    await fs.promises.writeFile(entitlementsPath, plist.build(defaultEntitlements));
}

async function execXcodeBuild(xcodeBuildArgs: string[]) {
    let output = '';
    const exitCode = await exec(xcodebuild, xcodeBuildArgs, {
        listeners: {
            stdout: (data: Buffer) => {
                output += data.toString();
            },
            stderr: (data: Buffer) => {
                output += data.toString();
            }
        },
        ignoreReturnCode: true
    });
    await parseBundleLog(output);
    if (exitCode !== 0) {
        throw new Error(`xcodebuild exited with code: ${exitCode}`);
    }
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
        '--apple-id', projectRef.credential.appleId,
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
    if (exitCode > 0) {
        log(outputJson, 'error');
        throw new Error(`Failed to upload app!`);
    }
    core.debug(outputJson);
    try {
        const whatsNew = await getWhatsNew();
        core.info(`Uploading test details...\n${whatsNew}`);
        await UpdateTestDetails(projectRef, projectRef.bundleVersion, whatsNew);
    } catch (error) {
        log(`Failed to upload test details!\n${JSON.stringify(error)}`, 'error');
    }
}

async function getWhatsNew(): Promise<string> {
    let whatsNew = core.getInput('whats-new');
    if (!whatsNew || whatsNew.length === 0) {
        const head = github.context.eventName === 'pull_request'
            ? github.context.payload.pull_request?.head.sha
            : github.context.sha || 'HEAD';
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
            if (branchName.includes('/')) {
                branchName = branchName.split('/')[1];
            }
        }
        const commitMessage = await execGit(['log', head, '-1', '--format=%B']);
        whatsNew = `[${commitSha.trim()}]${branchName.trim()}\n${commitMessage.trim()}`;
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
    const exitCode = await exec('git', args, {
        listeners: {
            stdout: (data: Buffer) => {
                output += data.toString();
            }
        }
    });
    if (exitCode > 0) {
        log(output, 'error');
        throw new Error(`Git failed with exit code: ${exitCode}`);
    }
    return output;
}