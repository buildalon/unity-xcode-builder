import core = require('@actions/core');
import exec = require('@actions/exec');
import {
    GetProjectDetails,
    ArchiveXcodeProject,
    ExportXcodeArchive,
    ValidateApp,
    UploadApp
} from './xcode';
import {
    ImportCredentials,
    RemoveCredentials
} from './AppleCredential';
import semver = require('semver');

const IS_POST = !!core.getState('isPost');

const main = async () => {
    try {
        if (!IS_POST) {
            core.saveState('isPost', true);
            const credential = await ImportCredentials();
            let xcodeVersionInputString = core.getInput('xcode-version');
            if (xcodeVersionInputString) {
                core.info(`Setting xcode version to ${xcodeVersionInputString}...`);
                // check if the xcode version is already installed, if not install it with xcodes
                let installedListOutput = '';
                await exec.exec('xcodes', ['installed'], {
                    // ignoreReturnCode: true,
                    listeners: {
                        stdout: (data: Buffer) => {
                            installedListOutput += data.toString();
                        }
                    }
                });
                // `xcodes installed` example output:
                // 16.1 (16B40) (Selected) /Applications/Xcode.app
                let installedList: semver.SemVer[] = [];
                let installedListMatch = installedListOutput.match(/^(?<version>\d+\.\d+)/gm);
                if (installedListMatch) {
                    installedList = installedListMatch.map((version) => semver.coerce(version, { loose: true }));
                }
                let availableListOutput = '';
                await exec.exec('xcodes', ['list'], {
                    // ignoreReturnCode: true,
                    listeners: {
                        stdout: (data: Buffer) => {
                            availableListOutput += data.toString();
                        }
                    }
                });
                // `xcodes list` example output:
                // 14.0 Beta (14A5228q)
                // 14.0 Beta 2 (14A5229c)
                // 14.0 Beta 3 (14A5270f)
                // 14.0 Beta 4 (14A5284g)
                // 14.0 Beta 5 (14A5294e)
                // 14.0 Beta 6 (14A5294g)
                // 14.0 (14A309)
                // 14.0.1 (14A400)
                // 14.1 Beta (14B5024h)
                // 14.1 Beta 2 (14B5024i)
                // 14.1 Beta 3 (14B5033e)
                // 14.1 Release Candidate (14B47)
                // 14.1 (14B47b)
                // 14.2 (14C18)
                // 14.3 Beta (14E5197f)
                // 14.3 Beta 2 (14E5207e)
                // 14.3 Beta 3 (14E5215g)
                // 14.3 Release Candidate (14E222a)
                // 14.3 (14E222b)
                // 14.3.1 Release Candidate (14E300b)
                // 14.3.1 (14E300c)
                let availableList: semver.SemVer[] = [];
                let availableListMatch = availableListOutput.match(/^(?<version>\d+\.\d+(\.\d+)?)/gm);
                if (availableListMatch) {
                    availableList = availableListMatch.map((version) => semver.coerce(version, { loose: true }));
                }
                let requestedVersion: semver.SemVer;
                const installLatest = xcodeVersionInputString === 'latest';
                if (!installLatest) {
                    const getMaxSatisfying = xcodeVersionInputString.includes('x');
                    let inputVersionParts = xcodeVersionInputString.split('.');
                    let finalVersionParts = [];
                    for (let i = 0; i < inputVersionParts.length; i++) {
                        if (inputVersionParts[i] !== 'x') {
                            finalVersionParts.push(inputVersionParts[i]);
                        }
                    }
                    requestedVersion = semver.coerce(finalVersionParts.join('.'), { loose: true });
                    if (getMaxSatisfying) {
                        requestedVersion = semver.maxSatisfying(availableList, requestedVersion.raw);
                    }
                } else {
                    requestedVersion = semver.maxSatisfying(availableList, '*');
                }
                if (!requestedVersion) {
                    throw new Error('Failed to parse requested Xcode version!');
                }
                let requestedVersionString = requestedVersion.raw;
                let versionParts = requestedVersionString.split('.');
                // if the version in the release position is 0, remove it
                if (versionParts[2] === '0') {
                    requestedVersionString = versionParts.slice(0, 2).join('.');
                }
                core.info(`Requested Xcode version: ${requestedVersionString}`);
                let xcodeVersionInstalled = installedList.find((version) => semver.eq(version, requestedVersion));
                if (!xcodeVersionInstalled) {
                    core.info(`Xcode version ${requestedVersionString} is not installed!`);
                    let xcodeVersionAvailable = availableList.find((version) => semver.eq(version, requestedVersion));
                    if (!xcodeVersionAvailable) {
                        throw new Error(`Xcode version ${requestedVersion} is not available!`);
                    }
                    // install the xcode version
                    let installOutput = '';
                    await exec.exec('xcodes', ['install', requestedVersionString], {
                        listeners: {
                            stdout: (data: Buffer) => {
                                installOutput += data.toString();
                            }
                        }
                    });
                }
                await exec.exec('xcodes', ['select', requestedVersionString]);
            }
            let xcodeVersionOutput = '';
            await exec.exec('xcodebuild', ['-version'], {
                listeners: {
                    stdout: (data: Buffer) => {
                        xcodeVersionOutput += data.toString();
                    }
                }
            });
            let projectRef = await GetProjectDetails();
            projectRef.credential = credential;
            projectRef.xcodeVersion = semver.coerce(xcodeVersionInputString);
            projectRef = await ArchiveXcodeProject(projectRef);
            projectRef = await ExportXcodeArchive(projectRef);
            const uploadInput = core.getInput('upload') || projectRef.isAppStoreUpload().toString();
            const upload = projectRef.isAppStoreUpload() && uploadInput === 'true';
            core.debug(`uploadInput: ${upload}`);
            if (upload) {
                await ValidateApp(projectRef);
                await UploadApp(projectRef);
            }
        } else {
            await RemoveCredentials();
        }
    } catch (error) {
        core.setFailed(error.stack);
    }
}

main();
