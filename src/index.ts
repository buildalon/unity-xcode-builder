import core = require('@actions/core');
import exec = require('@actions/exec');
import {
    ImportCredentials,
    Cleanup
} from './credentials';
import {
    GetProjectDetails,
    ArchiveXcodeProject,
    ExportXcodeArchive
} from './xcode';

const IS_POST = !!core.getState('isPost');

const main = async () => {
    try {
        if (!IS_POST) {
            core.saveState('isPost', true);
            const xcodeVersion = core.getInput('xcode-version');
            if (xcodeVersion) {
                core.info(`Setting xcode version to ${xcodeVersion}`);
                await exec.exec('sudo', ['xcode-select', '-s', `/Applications/Xcode_${xcodeVersion}.app/Contents/Developer`]);
            }
            await exec.exec('xcodebuild', ['-version']);
            const credential = await ImportCredentials();
            let projectRef = await GetProjectDetails();
            projectRef.credential = credential;
            projectRef = await ArchiveXcodeProject(projectRef);
            projectRef = await ExportXcodeArchive(projectRef);
            core.setOutput('output-directory', projectRef.exportPath);
        } else {
            await Cleanup();
        }
    } catch (error) {
        core.setFailed(error.stack);
    }
}

main();
