import core = require('@actions/core');
import exec = require('@actions/exec');
import uuid = require('uuid');
import fs = require('fs');

const security = '/usr/bin/security';
const temp = process.env['RUNNER_TEMP'] || '.';
const appStoreConnectKeyDir = `${process.env.HOME}/.appstoreconnect/private_keys`;

class AppleCredential {
    constructor(
        name: string,
        keychainPath: string,
        appStoreConnectKeyId: string,
        appStoreConnectIssuerId: string,
        appStoreConnectKeyPath?: string,
        appStoreConnectKey?: string,
        teamId?: string,
        signingIdentity?: string,
        provisioningProfileUUID?: string
    ) {
        this.name = name;
        this.keychainPath = keychainPath;
        this.appStoreConnectKeyId = appStoreConnectKeyId;
        this.appStoreConnectIssuerId = appStoreConnectIssuerId;
        this.appStoreConnectKeyPath = appStoreConnectKeyPath;
        this.appStoreConnectKey = appStoreConnectKey;
        this.teamId = teamId;
        this.signingIdentity = signingIdentity;
        this.provisioningProfileUUID = provisioningProfileUUID;
    }
    name: string;
    keychainPath: string;
    appStoreConnectKeyId: string;
    appStoreConnectIssuerId: string;
    appStoreConnectKeyPath?: string;
    appStoreConnectKey?: string;
    teamId?: string;
    signingIdentity?: string;
    provisioningProfileUUID?: string;
    bearerToken?: string;
    appleId?: string;
    ascPublicId?: string;
}

// https://docs.github.com/en/actions/use-cases-and-examples/deploying/installing-an-apple-certificate-on-macos-runners-for-xcode-development#add-a-step-to-your-workflow
async function ImportCredentials(): Promise<AppleCredential> {
    try {
        core.startGroup('Importing credentials...');
        const tempCredential = uuid.v4();
        core.setSecret(tempCredential);
        core.saveState('tempCredential', tempCredential);
        const authenticationKeyID = core.getInput('app-store-connect-key-id', { required: true });
        core.saveState('authenticationKeyID', authenticationKeyID);
        const authenticationKeyIssuerID = core.getInput('app-store-connect-issuer-id', { required: true });
        const appStoreConnectKeyBase64 = core.getInput('app-store-connect-key', { required: true });
        await fs.promises.mkdir(appStoreConnectKeyDir, { recursive: true });
        const appStoreConnectKeyPath = `${appStoreConnectKeyDir}/AuthKey_${authenticationKeyID}.p8`;
        const appStoreConnectKey = Buffer.from(appStoreConnectKeyBase64, 'base64').toString('utf8');
        core.setSecret(appStoreConnectKey);
        await fs.promises.writeFile(appStoreConnectKeyPath, appStoreConnectKey, 'utf8');
        const keychainPath = `${temp}/${tempCredential}.keychain-db`;
        await exec.exec(security, ['create-keychain', '-p', tempCredential, keychainPath]);
        await exec.exec(security, ['set-keychain-settings', '-lut', '21600', keychainPath]);
        await exec.exec(security, ['unlock-keychain', '-p', tempCredential, keychainPath]);
        let signingIdentity = core.getInput('signing-identity');
        let certificateUUID: string | undefined;
        let teamId = core.getInput('team-id');
        const certificateBase64 = core.getInput('certificate');
        if (certificateBase64) {
            const certificatePassword = core.getInput('certificate-password', { required: true });
            core.info('Importing certificate...');
            const certificatePath = `${temp}/${tempCredential}.p12`;
            const certificate = Buffer.from(certificateBase64, 'base64').toString('binary');
            await fs.promises.writeFile(certificatePath, certificate, 'binary');
            await exec.exec(security, ['import', certificatePath, '-P', certificatePassword, '-A', '-t', 'cert', '-f', 'pkcs12', '-k', keychainPath]);
            if (core.isDebug()) {
                core.info(`[command]${security} set-key-partition-list -S apple-tool:,apple:,codesign: -s -k ${tempCredential} ${keychainPath}`);
            }
            await exec.exec(security, ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', tempCredential, keychainPath], {
                silent: !core.isDebug()
            });
            await exec.exec(security, ['list-keychains', '-d', 'user', '-s', keychainPath, 'login.keychain-db']);
            await fs.promises.unlink(certificatePath);
            if (!signingIdentity) {
                let output = '';
                core.info(`[command]${security} find-identity -v -p codesigning ${keychainPath}`);
                await exec.exec(security, ['find-identity', '-v', '-p', 'codesigning', keychainPath], {
                    listeners: {
                        stdout: (data: Buffer) => {
                            output += data.toString();
                        }
                    },
                    silent: true
                });
                const match = output.match(/\d\) (?<uuid>\w+) \"(?<signing_identity>[^"]+)\"$/m);
                if (!match) {
                    throw new Error('Failed to match signing identity!');
                }
                certificateUUID = match.groups?.uuid;
                core.setSecret(certificateUUID);
                signingIdentity = match.groups?.signing_identity;
                if (!signingIdentity) {
                    throw new Error('Failed to find signing identity!');
                }
                if (!teamId) {
                    const teamMatch = signingIdentity.match(/(?<team_id>[A-Z0-9]{10})\s/);
                    if (!teamMatch) {
                        throw new Error('Failed to match team id!');
                    }
                    teamId = teamMatch.groups?.team_id;
                    if (!teamId) {
                        throw new Error('Failed to find team id!');
                    }
                    core.setSecret(teamId);
                }
                core.info(output);
            }
        }
        const provisioningProfileBase64 = core.getInput('provisioning-profile');
        let provisioningProfileUUID: string | undefined;
        if (provisioningProfileBase64) {
            core.info('Importing provisioning profile...');
            const provisioningProfileName = core.getInput('provisioning-profile-name', { required: true });
            if (!provisioningProfileName.endsWith('.mobileprovision') &&
                !provisioningProfileName.endsWith('.provisionprofile')) {
                throw new Error('Provisioning profile name must end with .mobileprovision or .provisionprofile');
            }
            const provisioningProfilePath = `${temp}/${provisioningProfileName}`;
            core.saveState('provisioningProfilePath', provisioningProfilePath);
            const provisioningProfile = Buffer.from(provisioningProfileBase64, 'base64').toString('binary');
            await fs.promises.writeFile(provisioningProfilePath, provisioningProfile, 'binary');
            const provisioningProfileContent = await fs.promises.readFile(provisioningProfilePath, 'utf8');
            const uuidMatch = provisioningProfileContent.match(/<key>UUID<\/key>\s*<string>([^<]+)<\/string>/);
            if (uuidMatch) {
                provisioningProfileUUID = uuidMatch[1];
            }
            if (!provisioningProfileUUID) {
                throw new Error('Failed to parse provisioning profile UUID');
            }
        }
        return new AppleCredential(
            tempCredential,
            keychainPath,
            authenticationKeyID,
            authenticationKeyIssuerID,
            appStoreConnectKeyPath,
            appStoreConnectKey,
            teamId,
            signingIdentity,
            provisioningProfileUUID
        );
    } finally {
        core.endGroup();
    }
}

async function RemoveCredentials(): Promise<void> {
    const provisioningProfilePath = core.getState('provisioningProfilePath');
    if (provisioningProfilePath) {
        core.info('Removing provisioning profile...');
        try {
            await fs.promises.unlink(provisioningProfilePath);
        } catch (error) {
            core.error(`Failed to remove provisioning profile!\n${error.stack}`);
        }
    }
    const tempCredential = core.getState('tempCredential');
    if (!tempCredential) {
        throw new Error('Missing tempCredential state');
    }
    core.info('Removing keychain...');
    const keychainPath = `${temp}/${tempCredential}.keychain-db`;
    await exec.exec(security, ['delete-keychain', keychainPath]);
    core.info('Removing credentials...');
    try {
        const authenticationKeyID = core.getState('authenticationKeyID');
        const appStoreConnectKeyPath = `${appStoreConnectKeyDir}/AuthKey_${authenticationKeyID}.p8`;
        await fs.promises.unlink(appStoreConnectKeyPath);
    } catch (error) {
        core.error(`Failed to remove app store connect key!\n${error.stack}`);
    }
}

export {
    ImportCredentials,
    RemoveCredentials,
    AppleCredential
}