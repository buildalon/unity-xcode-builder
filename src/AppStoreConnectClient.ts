import {
    AppStoreConnectClient,
    AppStoreConnectOptions
} from '@rage-against-the-pixel/app-store-connect-api';
import { XcodeProject } from './XcodeProject';
import {
    Build,
    BuildsGetCollectionData,
    BetaBuildLocalization,
    BetaBuildLocalizationUpdateRequest,
    BetaBuildLocalizationsGetCollectionData,
    PrereleaseVersion,
    PreReleaseVersionsGetCollectionData,
    BetaBuildLocalizationCreateRequest,
} from '@rage-against-the-pixel/app-store-connect-api/dist/app_store_connect_api';
import { log } from './utilities';
import core = require('@actions/core');

let appStoreConnectClient: AppStoreConnectClient | null = null;

export class UnauthorizedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnauthorizedError';
    }
}

async function getOrCreateClient(project: XcodeProject) {
    if (appStoreConnectClient) { return appStoreConnectClient; }
    if (!project.credential) {
        throw new UnauthorizedError('Missing AppleCredential!');
    }
    const options: AppStoreConnectOptions = {
        issuerId: project.credential.appStoreConnectIssuerId,
        privateKeyId: project.credential.appStoreConnectKeyId,
        privateKey: project.credential.appStoreConnectKey,
    };
    appStoreConnectClient = new AppStoreConnectClient(options);
}

function checkAuthError(error: any) {
    if (error && error.errors) {
        for (const e of error.errors) {
            if (e.status === '401') {
                throw new UnauthorizedError(e.message);
            }
        }
    }
}

export async function GetAppId(project: XcodeProject): Promise<string> {
    await getOrCreateClient(project);
    const { data: response, error } = await appStoreConnectClient.api.AppsService.appsGetCollection({
        query: { 'filter[bundleId]': [project.bundleId] }
    });
    if (error) {
        checkAuthError(error);
        throw new Error(`Error fetching apps: ${JSON.stringify(error)}`);
    }
    if (!response) {
        throw new Error(`No apps found for bundle id ${project.bundleId}`);
    }
    if (response.data.length === 0) {
        throw new Error(`No apps found for bundle id ${project.bundleId}`);
    }
    return response.data[0].id;
}

export async function GetLatestBundleVersion(project: XcodeProject): Promise<string | null> {
    await getOrCreateClient(project);
    let { preReleaseVersion, build } = await getLastPreReleaseVersionAndBuild(project);
    if (!build) {
        build = await getLastPrereleaseBuild(preReleaseVersion);
    }
    return build?.attributes?.version;
}

function reMapPlatform(project: XcodeProject): ('IOS' | 'MAC_OS' | 'TV_OS' | 'VISION_OS') {
    switch (project.platform) {
        case 'iOS':
            return 'IOS';
        case 'macOS':
            return 'MAC_OS';
        case 'tvOS':
            return 'TV_OS';
        case 'visionOS':
            return 'VISION_OS';
        default:
            throw new Error(`Unsupported platform: ${project.platform}`);
    }
}

async function getLastPreReleaseVersionAndBuild(project: XcodeProject): Promise<PreReleaseVersionWithBuild> {
    if (!project.appId) { project.appId = await GetAppId(project); }
    const preReleaseVersionRequest: PreReleaseVersionsGetCollectionData = {
        query: {
            'filter[app]': [project.appId],
            'filter[platform]': [reMapPlatform(project)],
            'filter[version]': [project.versionString],
            'limit[builds]': 1,
            sort: ['-version'],
            include: ['builds'],
            limit: 1,
        }
    };
    log(`/preReleaseVersions?${JSON.stringify(preReleaseVersionRequest.query)}`);
    const { data: preReleaseResponse, error: preReleaseError } = await appStoreConnectClient.api.PreReleaseVersionsService.preReleaseVersionsGetCollection(preReleaseVersionRequest);
    const responseJson = JSON.stringify(preReleaseResponse, null, 2);
    if (preReleaseError) {
        checkAuthError(preReleaseError);
        throw new Error(`Error fetching pre-release versions: ${responseJson}`);
    }
    log(responseJson);
    if (!preReleaseResponse || !preReleaseResponse.data || preReleaseResponse.data.length === 0) {
        return new PreReleaseVersionWithBuild({ preReleaseVersion: null, build: null });
    }
    let lastBuild: Build = null;
    const buildsData = preReleaseResponse.data[0].relationships?.builds?.data;
    if (buildsData && buildsData.length > 0) {
        const lastBuildId = buildsData[0]?.id ?? null;
        if (lastBuildId) {
            lastBuild = preReleaseResponse.included?.find(i => i.type == 'builds' && i.id == lastBuildId) as Build;
        }
    }
    return new PreReleaseVersionWithBuild({
        preReleaseVersion: preReleaseResponse.data[0],
        build: lastBuild
    });
}

class PreReleaseVersionWithBuild {
    preReleaseVersion?: PrereleaseVersion;
    build?: Build;
    constructor({ preReleaseVersion, build }: { preReleaseVersion: PrereleaseVersion, build: Build }) {
        this.preReleaseVersion = preReleaseVersion;
        this.build = build;
    }
}

async function getLastPrereleaseBuild(prereleaseVersion: PrereleaseVersion): Promise<Build> {
    const buildsRequest: BuildsGetCollectionData = {
        query: {
            'filter[preReleaseVersion]': [prereleaseVersion.id],
            sort: ['-version'],
            limit: 1
        }
    };
    log(`/builds?${JSON.stringify(buildsRequest.query)}`);
    const { data: buildsResponse, error: buildsError } = await appStoreConnectClient.api.BuildsService.buildsGetCollection(buildsRequest);
    const responseJson = JSON.stringify(buildsResponse, null, 2);
    if (buildsError) {
        checkAuthError(buildsError);
        throw new Error(`Error fetching builds: ${JSON.stringify(buildsError, null, 2)}`);
    }
    if (!buildsResponse || !buildsResponse.data || buildsResponse.data.length === 0) {
        throw new Error(`No builds found! ${responseJson}`);
    }
    log(responseJson);
    return buildsResponse.data[0];
}

async function getBetaBuildLocalization(build: Build): Promise<BetaBuildLocalization> {
    const betaBuildLocalizationRequest: BetaBuildLocalizationsGetCollectionData = {
        query: {
            'filter[build]': [build.id],
            "filter[locale]": ["en-US"],
            'fields[betaBuildLocalizations]': ['whatsNew']
        }
    };
    log(`/betaBuildLocalizations?${JSON.stringify(betaBuildLocalizationRequest.query)}`);
    const { data: betaBuildLocalizationResponse, error: betaBuildLocalizationError } = await appStoreConnectClient.api.BetaBuildLocalizationsService.betaBuildLocalizationsGetCollection(betaBuildLocalizationRequest);
    const responseJson = JSON.stringify(betaBuildLocalizationResponse, null, 2);
    if (betaBuildLocalizationError) {
        checkAuthError(betaBuildLocalizationError);
        throw new Error(`Error fetching beta build localization: ${JSON.stringify(betaBuildLocalizationError, null, 2)}`);
    }
    if (!betaBuildLocalizationResponse || betaBuildLocalizationResponse.data.length === 0) {
        return null;
    }
    log(responseJson);
    return betaBuildLocalizationResponse.data[0];
}

async function createBetaBuildLocalization(build: Build, whatsNew: string): Promise<BetaBuildLocalization> {
    const betaBuildLocalizationRequest: BetaBuildLocalizationCreateRequest = {
        data: {
            type: 'betaBuildLocalizations',
            attributes: {
                whatsNew: whatsNew,
                locale: 'en-US'
            },
            relationships: {
                build: {
                    data: {
                        id: build.id,
                        type: 'builds'
                    }
                }
            }
        }
    }
    log(`/betaBuildLocalizations\n${JSON.stringify(betaBuildLocalizationRequest, null, 2)}`);
    const { data: response, error: responseError } = await appStoreConnectClient.api.BetaBuildLocalizationsService.betaBuildLocalizationsCreateInstance({
        body: betaBuildLocalizationRequest
    });
    const responseJson = JSON.stringify(betaBuildLocalizationRequest, null, 2);
    if (responseError) {
        checkAuthError(responseError);
        throw new Error(`Error creating beta build localization: ${JSON.stringify(responseError, null, 2)}`);
    }
    log(responseJson);
    return response.data;
}

async function updateBetaBuildLocalization(betaBuildLocalization: BetaBuildLocalization, whatsNew: string): Promise<BetaBuildLocalization> {
    const updateBuildLocalization: BetaBuildLocalizationUpdateRequest = {
        data: {
            id: betaBuildLocalization.id,
            type: 'betaBuildLocalizations',
            attributes: {
                whatsNew: whatsNew
            }
        }
    };
    log(`/betaBuildLocalizations/${betaBuildLocalization.id}\n${JSON.stringify(updateBuildLocalization, null, 2)}`);
    const { error: updateError } = await appStoreConnectClient.api.BetaBuildLocalizationsService.betaBuildLocalizationsUpdateInstance({
        path: { id: betaBuildLocalization.id },
        body: updateBuildLocalization
    });
    const responseJson = JSON.stringify(updateBuildLocalization, null, 2);
    if (updateError) {
        checkAuthError(updateError);
        throw new Error(`Error updating beta build localization: ${JSON.stringify(updateError, null, 2)}`);
    }
    log(responseJson);
    return betaBuildLocalization;
}

async function pollForValidBuild(project: XcodeProject, maxRetries: number = 60, interval: number = 30): Promise<Build> {
    core.debug(`Polling build validation...`);
    await new Promise(resolve => setTimeout(resolve, interval * 1000));
    let retries = 0;
    let lastMessage = '';
    while (retries < maxRetries) {
        lastMessage = `Polling for build... Attempt ${retries}/${maxRetries}`;
        core.debug(lastMessage);
        let { preReleaseVersion, build } = await getLastPreReleaseVersionAndBuild(project);
        if (preReleaseVersion) {
            if (!build) {
                build = await getLastPrereleaseBuild(preReleaseVersion);
            }
            if (build) {
                const normalizedBuildVersion = normalizeVersion(build.attributes?.version);
                const normalizedProjectVersion = normalizeVersion(project.bundleVersion);
                switch (build.attributes?.processingState) {
                    case 'VALID':
                        if (normalizedBuildVersion === normalizedProjectVersion) {
                            core.debug(`Build ${build.attributes.version} is VALID`);
                            return build;
                        } else {
                            lastMessage = `Build ${build.attributes.version} is VALID but not the latest version ${project.bundleVersion}!`;
                        }
                        break;
                    case 'FAILED':
                    case 'INVALID':
                        throw new Error(`Build ${build.attributes.version} === ${build.attributes.processingState}!`);
                    default:
                        lastMessage = `Build ${build.attributes.version} is ${build.attributes.processingState}...`;
                        break;
                }
            } else {
                lastMessage = `No build found for ${preReleaseVersion.attributes?.version}!`;
            }
        } else {
            lastMessage = `No pre-release version found for ${project.versionString}!`;
        }
        core.debug(lastMessage);
        await new Promise(resolve => setTimeout(resolve, interval * 1000));
    }
    core.error(lastMessage);
    throw new Error('Timed out waiting for valid build!');
}

export async function UpdateTestDetails(project: XcodeProject, whatsNew: string): Promise<void> {
    core.info(`Updating test details...`);
    await getOrCreateClient(project);
    const build = await pollForValidBuild(project);
    const betaBuildLocalization = await getBetaBuildLocalization(build);
    if (!betaBuildLocalization) {
        core.info(`Creating beta build localization...`);
        await createBetaBuildLocalization(build, whatsNew);
    } else {
        core.info(`Updating beta build localization...`);
        await updateBetaBuildLocalization(betaBuildLocalization, whatsNew);
    }
}

function normalizeVersion(version: string): string {
    return version.split('.').map(part => parseInt(part, 10).toString()).join('.');
}