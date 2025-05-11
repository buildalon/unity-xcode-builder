import {
    CertificateType
} from '@rage-against-the-pixel/app-store-connect-api/dist/app_store_connect_api';
import {
    CreateNewCertificate,
    RevokeCertificate
} from './AppStoreConnectClient';
import {
    XcodeProject
} from './XcodeProject';
import core = require('@actions/core');
import exec = require('@actions/exec');
import uuid = require('uuid');
import path = require('path');
import fs = require('fs');

const security = '/usr/bin/security';
const temp = process.env['RUNNER_TEMP'] || '.';
const appStoreConnectKeyDir = `${process.env.HOME}/.appstoreconnect/private_keys`;

export class AppleCredential {
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
    ascPublicId?: string;
}

// https://docs.github.com/en/actions/use-cases-and-examples/deploying/installing-an-apple-certificate-on-macos-runners-for-xcode-development#add-a-step-to-your-workflow
export async function ImportCredentials(): Promise<AppleCredential> {
    try {
        core.startGroup('Importing credentials...');
        const tempCredential = uuid.v4();
        core.setSecret(tempCredential);
        core.saveState('tempCredential', tempCredential);
        const authenticationKeyID = core.getInput('app-store-connect-key-id', { required: true });
        core.saveState('authenticationKeyID', authenticationKeyID);
        const authenticationKeyIssuerID = core.getInput('app-store-connect-issuer-id', { required: true });
        core.saveState('authenticationKeyIssuerID', authenticationKeyIssuerID);
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
            const certificateDirectory = await getCertificateDirectory();
            const certificatePath = `${certificateDirectory}/${tempCredential}.p12`;
            const certificate = Buffer.from(certificateBase64, 'base64');
            await fs.promises.writeFile(certificatePath, certificate);
            await exec.exec(security, [
                'import', certificatePath,
                '-P', certificatePassword,
                '-A', '-t', 'cert', '-f', 'pkcs12',
                '-k', keychainPath]);
            if (core.isDebug()) {
                core.info(`[command]${security} set-key-partition-list -S apple-tool:,apple:,codesign: -s -k ${tempCredential} ${keychainPath}`);
            }
            await exec.exec(security, ['set-key-partition-list', '-S', 'apple-tool:,apple:,codesign:', '-s', '-k', tempCredential, keychainPath], {
                silent: !core.isDebug()
            });
            await exec.exec(security, ['list-keychains', '-d', 'user', '-s', keychainPath, 'login.keychain-db']);
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

export async function RemoveCredentials(): Promise<void> {
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
    if (tempCredential) {
        core.info('Removing keychain...');
        const keychainPath = `${temp}/${tempCredential}.keychain-db`;
        await exec.exec(security, ['delete-keychain', keychainPath]);
    } else {
        core.error('Missing tempCredential state');
    }
    core.info('Revoking temp signing certificates...');
    const authenticationKeyID = core.getState('authenticationKeyID');
    const authenticationKeyIssuerID = core.getState('authenticationKeyIssuerID');
    const appStoreConnectKeyPath = `${appStoreConnectKeyDir}/AuthKey_${authenticationKeyID}.p8`;
    const certificateDirectory = await getCertificateDirectory();
    const tempSigningCertificateIds = (await fs.promises.readdir(certificateDirectory))
        .filter(file => file.endsWith('.csr'))
        .map(file => {
            // CERTIFICATE_TYPE-uuid-1234.csr
            const match = file.match(/^(?<type>[A-Z_]+)-(?<id>[\w-]+)\.csr$/);
            if (!match) {
                core.warning(`Failed to match signing certificate id from ${file}`);
                return null;
            }
            return match.groups?.id;
        }).filter(id => id !== null) as Array<string>;
    if (tempSigningCertificateIds &&
        tempSigningCertificateIds.length > 0) {
        core.info('Revoking temp signing certificates...');
        for (const tempSigningCertificateId of tempSigningCertificateIds) {
            try {
                await RevokeCertificate(tempSigningCertificateId, {
                    privateKey: appStoreConnectKeyPath,
                    privateKeyId: authenticationKeyID,
                    issuerId: authenticationKeyIssuerID
                });
            } catch (error) {
                core.error(`Failed to revoke temp signing certificate ${tempSigningCertificateId}!\n${error.stack}`);
            }
        }
    }
    core.info('Removing credentials...');
    try {
        await fs.promises.unlink(appStoreConnectKeyPath);
    } catch (error) {
        core.error(`Failed to remove app store connect key!\n${error.stack}`);
    }
    core.info('Removing certificate directory...');
    try {
        await fs.promises.rmdir(certificateDirectory, { recursive: true });
    } catch (error) {
        core.error(`Failed to remove certificate directory!\n${error.stack}`);
    }
}

export async function CreateSigningCertificate(project: XcodeProject, certificateType: CertificateType) {
    const csrContent = await createCSR(project.credential.name, certificateType);
    const certificate = await CreateNewCertificate(project, certificateType, csrContent);
    const certificateDirectory = await getCertificateDirectory();
    const certificateName = `${certificateType}-${certificate.id}.cer`;
    const certificatePath = `${certificateDirectory}/${certificateName}`;
    core.debug(`Certificate path: ${certificatePath}`);
    const certificateContent = Buffer.from(certificate.attributes.certificateContent, 'base64');
    await fs.promises.writeFile(certificatePath, certificateContent);
    await exec.exec(security, [
        'import', certificatePath,
        '-A', '-t', 'cert', '-f', 'x509',
        '-k', project.credential.keychainPath,
    ]);
    return project;
}

async function createCSR(tempCredential: string, certificateType: CertificateType): Promise<string> {
    const certificateDirectory = await getCertificateDirectory();
    const privateKeyPath = path.join(certificateDirectory, `signing-${tempCredential}.key`);
    const csrPath = path.join(certificateDirectory, `signing-${tempCredential}.csr`);
    // Generate a new RSA private key (encrypted with tempCredential as passphrase)
    core.info(`[command]openssl genpkey -algorithm RSA -aes256 -pass pass:${tempCredential} -out ${privateKeyPath} -pkeyopt rsa_keygen_bits:2048`);
    await exec.exec('openssl', [
        'genpkey',
        '-algorithm', 'RSA',
        '-aes256',
        '-pass', `pass:${tempCredential}`,
        '-out', privateKeyPath,
        '-pkeyopt', 'rsa_keygen_bits:2048'
    ], { silent: true });
    // Ensure subject always starts with /CN=
    const subject = `/CN=${certificateType}/O=App Store Connect API`;
    core.info(`[command]openssl req -new -key ${privateKeyPath} -out ${csrPath} -subj "${subject}" -passin pass:${tempCredential}`);
    await exec.exec('openssl', [
        'req', '-new',
        '-key', privateKeyPath,
        '-out', csrPath,
        '-subj', subject,
        '-passin', `pass:${tempCredential}`
    ], { silent: true });
    return await fs.promises.readFile(csrPath, 'utf8');
}

async function getCertificateDirectory(): Promise<string> {
    const certificateDirectory = `${temp}/certificates`;
    try {
        await fs.promises.access(certificateDirectory, fs.constants.R_OK)
    } catch (error) {
        core.info(`Creating directory ${certificateDirectory}`);
        await fs.promises.mkdir(certificateDirectory, { recursive: true });
    }
    return certificateDirectory;
}