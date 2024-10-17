import { AppleCredential } from './AppleCredential';
import { SemVer } from 'semver';

export class XcodeProject {
    constructor(
        projectPath: string,
        projectName: string,
        platform: string,
        bundleId: string,
        projectDirectory: string,
        versionString: string,
        scheme: string,
    ) {
        this.projectPath = projectPath;
        this.projectName = projectName;
        this.platform = platform;
        this.bundleId = bundleId;
        this.projectDirectory = projectDirectory;
        this.versionString = versionString;
        this.scheme = scheme;
    }
    projectPath: string;
    projectName: string;
    bundleId: string;
    projectDirectory: string;
    credential: AppleCredential;
    platform: string;
    archivePath: string;
    exportPath: string;
    executablePath: string;
    exportOption: string;
    exportOptionsPath: string;
    entitlementsPath: string;
    appId: string;
    versionString: string;
    scheme: string;
    xcodeVersion: SemVer;
    isAppStoreUpload(): boolean {
        return this.exportOption === 'app-store' || this.exportOption === 'app-store-connect';
    }
}