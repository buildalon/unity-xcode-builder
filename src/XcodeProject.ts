import { AppleCredential } from './AppleCredential';
import { SemVer } from 'semver';

export class XcodeProject {
    constructor(
        projectPath: string,
        projectName: string,
        platform: string,
        destination: string,
        bundleId: string,
        projectDirectory: string,
        versionString: string,
        bundleVersion: number,
        scheme: string,
        credential: AppleCredential,
        xcodeVersion: SemVer
    ) {
        this.projectPath = projectPath;
        this.projectName = projectName;
        this.platform = platform;
        this.destination = destination;
        this.bundleId = bundleId;
        this.projectDirectory = projectDirectory;
        this.versionString = versionString;
        this.bundleVersion = bundleVersion;
        this.scheme = scheme;
        this.credential = credential
        this.xcodeVersion = xcodeVersion;
    }
    projectPath: string;
    projectName: string;
    bundleId: string;
    appId: string;
    projectDirectory: string;
    credential: AppleCredential;
    platform: string;
    destination: string;
    archivePath: string;
    exportPath: string;
    executablePath: string;
    exportOption: string;
    exportOptionsPath: string;
    entitlementsPath: string;
    versionString: string;
    bundleVersion: number;
    scheme: string;
    xcodeVersion: SemVer;
    isAppStoreUpload(): boolean {
        return this.exportOption === 'app-store' || this.exportOption === 'app-store-connect';
    }
}