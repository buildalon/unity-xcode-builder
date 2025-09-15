import { AppleCredential } from './AppleCredential';
import { SemVer } from 'semver';

export class XcodeProject {
    constructor(
        projectPath: string,
        projectName: string,
        projectDirectory: string,
        platform: string,
        destination: string,
        configuration: string,
        bundleId: string,
        versionString: string,
        bundleVersion: string,
        scheme: string,
        credential: AppleCredential,
        xcodeVersion: SemVer
    ) {
        this.projectPath = projectPath;
        this.projectName = projectName;
        this.projectDirectory = projectDirectory;
        this.platform = platform;
        this.destination = destination;
        this.configuration = configuration;
        this.bundleId = bundleId;
        this.versionString = versionString;
        this.bundleVersion = bundleVersion;
        this.scheme = scheme;
        this.credential = credential
        this.xcodeVersion = xcodeVersion;
        this.isSteamBuild = false;
        this.archivePath = `${projectDirectory}/${projectName}.xcarchive`;
        this.exportPath = `${projectDirectory}/${projectName}`;
    }
    projectPath: string;
    projectName: string;
    projectDirectory: string;
    bundleId: string;
    appId: string;
    credential: AppleCredential;
    platform: string;
    destination: string;
    configuration: string;
    archivePath: string;
    exportPath: string;
    executablePath: string;
    exportOption: string;
    exportOptionsPath: string;
    entitlementsPath: string | undefined = undefined;
    versionString: string;
    bundleVersion: string;
    scheme: string;
    xcodeVersion: SemVer;
    autoIncrementBuildNumber: boolean;
    isSteamBuild: boolean;
    archiveType: string;
    notarize: boolean;
    isAppStoreUpload(): boolean {
        return this.exportOption === 'app-store' || this.exportOption === 'app-store-connect';
    }
}