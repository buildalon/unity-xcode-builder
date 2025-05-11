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
    Certificate,
    CertificateType,
    CertificatesCreateInstanceData,
    CertificatesDeleteInstanceData,
    CertificatesGetCollectionData,
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
    log(`GET /builds?${JSON.stringify(buildsRequest.query)}`);
    const { data: buildsResponse, error: responseError } = await appStoreConnectClient.api.BuildsService.buildsGetCollection(buildsRequest);
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
        query: {
            'filter[build]': [build.id],
            'filter[locale]': ['en-US'],
            'fields[betaBuildLocalizations]': ['whatsNew']
        }
    };
    log(`GET /betaBuildLocalizations?${JSON.stringify(betaBuildLocalizationRequest.query)}`);
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
    log(`POST /betaBuildLocalizations\n${JSON.stringify(betaBuildLocalizationRequest, null, 2)}`);
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
    log(`POST /betaBuildLocalizations/${betaBuildLocalization.id}\n${JSON.stringify(updateBuildLocalization, null, 2)}`);
    const { error: updateError } = await appStoreConnectClient.api.BetaBuildLocalizationsService.betaBuildLocalizationsUpdateInstance({
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
    core.info(`Adding Beta groups: ${testGroups}`);
    if (!testGroups) { return; }
    const testGroupNames = testGroups.split(',').map(group => group.trim());
    await AddBuildToTestGroups(project, build, testGroupNames);
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
        path: { id: build.id },
        body: { data: betaGroups }
    };
    log(`POST /builds/${build.id}/relationships/betaGroups\n${JSON.stringify(payload, null, 2)}`);
    const { error } = await appStoreConnectClient.api.BuildsService.buildsBetaGroupsCreateToManyRelationship(payload);
    if (error) {
        checkAuthError(error);
        throw new Error(`Error adding build to test group: ${JSON.stringify(error, null, 2)}`);
    }
}

async function getBetaGroupsByName(project: XcodeProject, groupNames: string[]): Promise<BetaGroup[]> {
    await getOrCreateClient(project);
    const appId = project.appId || await GetAppId(project);
    const request: BetaGroupsGetCollectionData = {
        query: {
            'filter[name]': groupNames,
            'filter[app]': [appId],
        }
    }
    log(`GET /betaGroups?${JSON.stringify(request.query)}`);
    const { data: response, error } = await appStoreConnectClient.api.BetaGroupsService.betaGroupsGetCollection(request);
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

export async function CreateNewCertificate(project: XcodeProject, certificateType: CertificateType, csrContent: string): Promise<Certificate> {
    await getOrCreateClient(project);
    const request: CertificatesCreateInstanceData = {
        body: {
            data: {
                type: 'certificates',
                attributes: {
                    certificateType: certificateType,
                    csrContent: csrContent
                }
            }
        }
    }
    log(`POST /certificates\n${JSON.stringify(request, null, 2)}`);
    const { data: response, error } = await appStoreConnectClient.api.CertificatesService.certificatesCreateInstance(request)
    if (error) {
        checkAuthError(error);
        throw new Error(`Error creating certificate: ${JSON.stringify(error, null, 2)}`);
    }
    const responseJson = JSON.stringify(response, null, 2);
    if (!response || !response.data) {
        throw new Error(`No certificate found!`);
    }
    core.info(responseJson);
    return response.data;
}

export async function GetCertificates(project: XcodeProject, certificateType: CertificateType): Promise<Certificate[]> {
    await getOrCreateClient(project);
    const request: CertificatesGetCollectionData = {
        query: {
            "filter[certificateType]": [certificateType]
        }
    };
    core.info(`GET /certificates?${JSON.stringify(request.query)}`);
    const { data: response, error } = await appStoreConnectClient.api.CertificatesService.certificatesGetCollection(request);
    if (error) {
        checkAuthError(error);
        throw new Error(`Error fetching certificates: ${JSON.stringify(error, null, 2)}`);
    }
    const responseJson = JSON.stringify(response, null, 2);
    if (!response || !response.data || response.data.length === 0) {
        return [];
    }
    core.info(responseJson);
    return response.data.filter(certificate => {
        certificate.attributes?.displayName === 'Created via API';
    });
}

export async function RevokeCertificate(certificateId: string, options: AppStoreConnectOptions): Promise<void> {
    appStoreConnectClient = new AppStoreConnectClient(options);
    const request: CertificatesDeleteInstanceData = { path: { id: certificateId } };
    core.info(`DELETE /certificates/${certificateId}`);
    const { error } = await appStoreConnectClient.api.CertificatesService.certificatesDeleteInstance(request);
    if (error) {
        checkAuthError(error);
        throw new Error(`Error revoking certificate: ${JSON.stringify(error, null, 2)}`);
    }
}