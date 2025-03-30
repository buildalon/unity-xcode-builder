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
                await exec.exec('xcodes', ['list']);
                if (xcodeVersionString.includes('latest')) {
                    await exec.exec('xcodes', ['install', '--latest', '--select']);
                } else {
                    await exec.exec('xcodes', ['install', xcodeVersionString, '--select']);
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
