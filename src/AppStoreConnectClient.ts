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
    BetaGroupsGetCollectionData,
    BuildsBetaGroupsCreateToManyRelationshipData,
    BetaGroup,
    BetaAppReviewSubmissionsCreateInstanceData,
    BuildBetaDetailsGetCollectionData,
    BuildBetaDetailsUpdateInstanceData,
    BuildBetaDetail,
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
    const { data: response, error } = await appStoreConnectClient.api.Apps.appsGetCollection({
        query: { 'filter[bundleId]': [project.bundleId] }
    });
    if (error) {
        checkAuthError(error);
        throw new Error(`Error fetching apps: ${JSON.stringify(error)}`);
    }
    log(`GET /appsGetCollection\n${JSON.stringify(response, null, 2)}`);
    if (!response) {
        throw new Error(`No apps found for bundle id ${project.bundleId}`);
    }
    if (response.data.length === 0) {
        throw new Error(`No apps found for bundle id ${project.bundleId}`);
    }
    if (response.data.length > 1) {
        log(`Multiple apps found for bundle id ${project.bundleId}!`);
        for (const app of response.data) {
            log(`[${app.id}] ${app.attributes?.bundleId}`);
            if (project.bundleId === app.attributes?.bundleId) {
                return app.id;
            }
        }
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
        url: '/v1/preReleaseVersions',
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
    log(`GET /preReleaseVersions?${JSON.stringify(preReleaseVersionRequest.query)}`);
    const { data: preReleaseResponse, error: preReleaseError } = await appStoreConnectClient.api.PreReleaseVersions.preReleaseVersionsGetCollection(preReleaseVersionRequest);
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
        url: '/v1/builds',
        query: {
            'filter[preReleaseVersion]': [prereleaseVersion.id],
            sort: ['-version'],
            limit: 1
        }
    };
    log(`GET /builds?${JSON.stringify(buildsRequest.query)}`);
    const { data: buildsResponse, error: responseError } = await appStoreConnectClient.api.Builds.buildsGetCollection(buildsRequest);
    if (responseError) {
        checkAuthError(responseError);
        throw new Error(`Error fetching builds: ${JSON.stringify(responseError, null, 2)}`);
    }
    const responseJson = JSON.stringify(buildsResponse, null, 2);
    if (!buildsResponse || !buildsResponse.data || buildsResponse.data.length === 0) {
        throw new Error(`No builds found! ${responseJson}`);
    }
    log(responseJson);
    return buildsResponse.data[0];
}

async function getBetaBuildLocalization(build: Build): Promise<BetaBuildLocalization> {
    const betaBuildLocalizationRequest: BetaBuildLocalizationsGetCollectionData = {
        url: '/v1/betaBuildLocalizations',
        query: {
            'filter[build]': [build.id],
            'filter[locale]': ['en-US'],
            'fields[betaBuildLocalizations]': ['whatsNew']
        }
    };
    log(`GET /betaBuildLocalizations?${JSON.stringify(betaBuildLocalizationRequest.query)}`);
    const { data: betaBuildLocalizationResponse, error: betaBuildLocalizationError } = await appStoreConnectClient.api.BetaBuildLocalizations.betaBuildLocalizationsGetCollection(betaBuildLocalizationRequest);
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
    log(`POST /betaBuildLocalizations\n${JSON.stringify(betaBuildLocalizationRequest, null, 2)}`);
    const { data: response, error: responseError } = await appStoreConnectClient.api.BetaBuildLocalizations.betaBuildLocalizationsCreateInstance({
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
    log(`POST /betaBuildLocalizations/${betaBuildLocalization.id}\n${JSON.stringify(updateBuildLocalization, null, 2)}`);
    const { error: updateError } = await appStoreConnectClient.api.BetaBuildLocalizations.betaBuildLocalizationsUpdateInstance({
        path: { id: betaBuildLocalization.id },
        body: updateBuildLocalization
    });
    if (updateError) {
        checkAuthError(updateError);
        throw new Error(`Error updating beta build localization: ${JSON.stringify(updateError, null, 2)}`);
    }
    return betaBuildLocalization;
}

async function pollForValidBuild(project: XcodeProject, maxRetries: number = 180, interval: number = 30): Promise<Build> {
    log(`Polling build validation...`);
    let retries = 0;
    while (++retries < maxRetries) {
        await new Promise(resolve => setTimeout(resolve, interval * 1000));
        core.info(`Polling for build... Attempt ${retries}/${maxRetries}`);
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
                            core.info(`Build ${build.attributes.version} is VALID`);
                            return build;
                        } else {
                            core.info(`Waiting for ${project.bundleVersion}...`);
                        }
                        break;
                    case 'FAILED':
                    case 'INVALID':
                        throw new Error(`Build ${build.attributes.version} === ${build.attributes.processingState}!`);
                    default:
                        core.info(`Build ${build.attributes.version} is ${build.attributes.processingState}...`);
                        break;
                }
            } else {
                core.info(`Waiting for build ${preReleaseVersion.attributes?.version}...`);
            }
        } else {
            core.info(`Waiting for pre-release build ${project.versionString}...`);
        }
    }
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
    const testGroups = core.getInput('test-groups');
    if (testGroups) {
        core.info(`Adding Beta groups: ${testGroups}`);
        const testGroupNames = testGroups.split(',').map(group => group.trim());
        await AddBuildToTestGroups(project, build, testGroupNames);
    }
    const submitForReview = core.getInput('submit-for-review');
    if (submitForReview) {
        core.info(`Submitting for review...`);
        await submitBetaBuildForReview(project, build);
        await autoNotifyBetaUsers(project, build);
    }
}

async function submitBetaBuildForReview(project: XcodeProject, build: Build): Promise<void> {
    await getOrCreateClient(project);
    const payload: BetaAppReviewSubmissionsCreateInstanceData = {
        url: '/v1/betaAppReviewSubmissions',
        body: {
            data: {
                relationships: {
                    build: {
                        data: {
                            id: build.id,
                            type: 'builds'
                        }
                    }
                },
                type: 'betaAppReviewSubmissions',
            }
        }
    };
    log(`POST /betaAppReviewSubmissions\n${JSON.stringify(payload, null, 2)}`);
    const { data: response, error } = await appStoreConnectClient.api.BetaAppReviewSubmissions.betaAppReviewSubmissionsCreateInstance(payload);
    if (error) {
        checkAuthError(error);
        throw new Error(`Error submitting beta build for review: ${JSON.stringify(error, null, 2)}`);
    }
    const responseJson = JSON.stringify(response, null, 2);
    log(responseJson);
    if (!response || !response.data) {
        throw new Error(`No beta build review submission returned!\n${responseJson}`);
    }
    core.info(`Beta build is ${response.data.attributes?.betaReviewState ?? 'UNKNOWN'}`);
}

async function autoNotifyBetaUsers(project: XcodeProject, build: Build): Promise<void> {
    await getOrCreateClient(project);
    let buildBetaDetail: BuildBetaDetail = null;
    if (!build.relationships?.buildBetaDetail) {
        buildBetaDetail = await getBetaAppBuildSubmissionDetails(build);
    } else {
        buildBetaDetail = build.relationships.buildBetaDetail.data;
    }
    if (!buildBetaDetail.attributes?.autoNotifyEnabled) {
        const payload: BuildBetaDetailsUpdateInstanceData = {
            url: `/v1/buildBetaDetails/{id}`,
            path: { id: buildBetaDetail.id },
            body: {
                data: {
                    id: buildBetaDetail.id,
                    type: 'buildBetaDetails',
                    attributes: {
                        autoNotifyEnabled: true
                    }
                }
            }
        };
        const { data: response, error } = await appStoreConnectClient.api.BuildBetaDetails.buildBetaDetailsUpdateInstance(payload);
        if (error) {
            checkAuthError(error);
            throw new Error(`Error updating beta build details: ${JSON.stringify(error, null, 2)}`);
        }
        const responseJson = JSON.stringify(response, null, 2);
        log(responseJson);
    }
}

async function getBetaAppBuildSubmissionDetails(build: Build): Promise<BuildBetaDetail> {
    const payload: BuildBetaDetailsGetCollectionData = {
        url: '/v1/buildBetaDetails',
        query: {
            "filter[build]": [build.id],
            limit: 1
        }
    };
    const { data: response, error } = await appStoreConnectClient.api.BuildBetaDetails.buildBetaDetailsGetCollection(payload);
    if (error) {
        checkAuthError(error);
        throw new Error(`Error fetching beta build details: ${JSON.stringify(error, null, 2)}`);
    }
    const responseJson = JSON.stringify(response, null, 2);
    if (!response || !response.data || response.data.length === 0) {
        throw new Error(`No beta build details found!`);
    }
    log(responseJson);
    return response.data[0];
}

function normalizeVersion(version: string): string {
    return version.split('.').map(part => parseInt(part, 10).toString()).join('.');
}

export async function AddBuildToTestGroups(project: XcodeProject, build: Build, testGroups: string[]): Promise<void> {
    await getOrCreateClient(project);
    const betaGroups = (await getBetaGroupsByName(project, testGroups)).map(group => ({
        type: group.type,
        id: group.id
    }));
    const payload: BuildsBetaGroupsCreateToManyRelationshipData = {
        url: '/v1/builds/{id}/relationships/betaGroups',
        path: { id: build.id },
        body: { data: betaGroups }
    };
    log(`POST /builds/${build.id}/relationships/betaGroups\n${JSON.stringify(payload, null, 2)}`);
    const { error } = await appStoreConnectClient.api.Builds.buildsBetaGroupsCreateToManyRelationship(payload);
    if (error) {
        checkAuthError(error);
        throw new Error(`Error adding build to test group: ${JSON.stringify(error, null, 2)}`);
    }
}

async function getBetaGroupsByName(project: XcodeProject, groupNames: string[]): Promise<BetaGroup[]> {
    await getOrCreateClient(project);
    const appId = project.appId || await GetAppId(project);
    const request: BetaGroupsGetCollectionData = {
        url: '/v1/betaGroups',
        query: {
            'filter[name]': groupNames,
            'filter[app]': [appId],
        }
    }
    log(`GET /betaGroups?${JSON.stringify(request.query)}`);
    const { data: response, error } = await appStoreConnectClient.api.BetaGroups.betaGroupsGetCollection(request);
    if (error) {
        checkAuthError(error);
        throw new Error(`Error fetching test groups: ${JSON.stringify(error)}`);
    }
    const responseJson = JSON.stringify(response, null, 2);
    if (!response || !response.data || response.data.length === 0) {
        throw new Error(`No test groups found!`);
    }
    log(responseJson);
    return response.data;
}
