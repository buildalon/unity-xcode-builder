import core = require('@actions/core');
import {
    GetProjectDetails,
    ArchiveXcodeProject,
    ExportXcodeArchive,
    ValidateApp,
    UploadApp,
    GetOrSetXcodeVersion
} from './xcode';
import {
    ImportCredentials,
    RemoveCredentials
} from './AppleCredential';

const IS_POST = !!core.getState('isPost');

const main = async () => {
    try {
        if (!IS_POST) {
            core.saveState('isPost', true);
            const credential = await ImportCredentials();
            const xcodeVersion = await GetOrSetXcodeVersion();
            let projectRef = await GetProjectDetails(credential, xcodeVersion);
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
