
import core = require('@actions/core');
import glob = require('@actions/glob');
import fs = require('fs');

export function log(message: string, type: 'info' | 'warning' | 'error' = 'info') {
    if (type == 'info' && !core.isDebug()) { return; }
    const lines = message.split('\n');
    const filteredLines = lines.filter((line) => line.trim() !== '');
    const uniqueLines = Array.from(new Set(filteredLines));
    let first = true;
    for (const line of uniqueLines) {
        if (first) {
            first = false;
            switch (type) {
                case 'info':
                    core.info(line);
                    break;
                case 'warning':
                    core.warning(line);
                    break;
                case 'error':
                    core.error(line);
                    break;
            }
        } else {
            core.info(line);
        }
    }
}

export function DeepEqual(a: any, b: any): boolean {
    if (a === b) return true;
    if (typeof a !== typeof b) return false;
    if (typeof a !== 'object' || a === null || b === null) return false;
    if (Array.isArray(a) !== Array.isArray(b)) return false;

    if (Array.isArray(a)) {
        if (a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (!DeepEqual(a[i], b[i])) return false;
        }
        return true;
    }

    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    if (keysA.length !== keysB.length) return false;
    for (const key of keysA) {
        if (!keysB.includes(key)) return false;
        if (!DeepEqual(a[key], b[key])) return false;
    }
    return true;
}

export function matchRegexPattern(string: string, pattern: RegExp, group: string | null): string {
    const match = string.match(pattern);

    if (!match) {
        throw new Error(`Failed to resolve: ${pattern}`);
    }

    return group ? match.groups?.[group] : match[1];
}

export async function getPathsWithGlob(globPattern: string): Promise<string[]> {
    const globber = await glob.create(globPattern);
    const files = await globber.glob();

    if (files.length === 0) {
        throw new Error(`No file found at: ${globPattern}`);
    }

    return files;
}

export async function getFirstPathWithGlob(globPattern: string): Promise<string> {
    const globber = await glob.create(globPattern);
    const files = await globber.glob();

    if (files.length === 0) {
        throw new Error(`No file found at: ${globPattern}`);
    }

    return files[0];
}

export async function getFileContents(filePath: string, printContent: boolean = true): Promise<string> {
    let fileContents: string = '';

    if (printContent) {
        core.startGroup(`${filePath} content:`);
    }

    const fileHandle = await fs.promises.open(filePath, fs.constants.O_RDONLY);

    try {
        fileContents = await fs.promises.readFile(fileHandle, 'utf8');
    } finally {
        await fileHandle.close();

        if (printContent) {
            core.info(fileContents);
            core.endGroup();
        }
    }

    return fileContents;
}
