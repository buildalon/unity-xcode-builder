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
            let xcodeVersionString = core.getInput('xcode-version');
            if (xcodeVersionString) {
                core.info(`Setting xcode version to ${xcodeVersionString}`);
                let xcodeVersionOutput = '';
                const installedExitCode = await exec.exec('xcodes', ['installed'], {
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
                core.debug(`Installed Xcode versions:\n  ${installedXcodeVersions.join('\n')}`);
                if (installedXcodeVersions.length === 0 ||
                    !xcodeVersionString.includes('latest')) {
                    if (installedXcodeVersions.length === 0 ||
                        !installedXcodeVersions.includes(xcodeVersionString)) {
                        const xcodesUsername = process.env.XCODES_USERNAME;
                        const xcodesPassword = process.env.XCODES_PASSWORD;
                        if (!xcodesUsername || !xcodesPassword) {
                            throw new Error(`Xcode version ${xcodeVersionString} is not installed! Please set XCODES_USERNAME and XCODES_PASSWORD to download it.`);
                        }
                        core.info(`Downloading missing Xcode version ${xcodeVersionString}...`);
                        const installExitCode = await exec.exec('xcodes', ['install', xcodeVersionString, '--select'], {
                            env: {
                                XCODES_USERNAME: xcodesUsername,
                                XCODES_PASSWORD: xcodesPassword
                            }
                        });
                        if (installExitCode !== 0) {
                            throw new Error(`Failed to install Xcode version ${xcodeVersionString}!`);
                        }
                    } else {
                        const selectExitCode = await exec.exec('xcodes', ['select', xcodeVersionString]);
                        if (selectExitCode !== 0) {
                            throw new Error(`Failed to select Xcode version ${xcodeVersionString}!`);
                        }
                    }
                } else {
                    core.info(`Selecting latest installed Xcode version ${xcodeVersionString}...`);
                    const latestXcodeVersion = installedXcodeVersions[installedXcodeVersions.length - 1];
                    const selectExitCode = await exec.exec('xcodes', ['select', latestXcodeVersion]);
                    if (selectExitCode !== 0) {
                        throw new Error(`Failed to select Xcode version ${latestXcodeVersion}!`);
                    }
                }
            }
            let xcodeVersionOutput = '';
            await exec.exec('xcodebuild', ['-version'], {
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
            xcodeVersionString = xcodeVersionMatch.groups.version;
            if (!xcodeVersionString) {
                throw new Error('Failed to parse Xcode version!');
            }
            let projectRef = await GetProjectDetails(credential, semver.coerce(xcodeVersionString));
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
