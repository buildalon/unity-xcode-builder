
import core = require('@actions/core');
import { exec } from '@actions/exec';

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

export async function SetupCCache() {
    let isFound = false;
    try {
        await exec('which', ['ccache'], {
            silent: true
        });
        isFound = true;
    } catch {
        try {
            await exec('brew', ['install', 'ccache']);
            isFound = true;
        } catch {
            core.warning('ccache could not be installed. Proceeding without ccache.');
        }
    }
    if (isFound) {
        process.env.CC = 'ccache clang';
        process.env.CXX = 'ccache clang++';
        core.info('ccache is enabled for Xcode builds.');
    } else {
        throw new Error('ccache is not available. Please install ccache to enable caching for Xcode builds.');
    }
}