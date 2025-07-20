
import core = require('@actions/core');
import { exec } from '@actions/exec';
import fs = require('fs');
import path = require('path');

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
    let ccachePath = '';
    try {
        let output = '';
        await exec('which', ['ccache'], {
            silent: true,
            listeners: {
                stdout: (data: Buffer) => { output += data.toString(); }
            }
        });
        ccachePath = output.trim();
        isFound = !!ccachePath;
    } catch {
        try {
            await exec('brew', ['install', 'ccache']);
            let output = '';
            await exec('which', ['ccache'], {
                silent: true,
                listeners: {
                    stdout: (data: Buffer) => { output += data.toString(); }
                }
            });
            ccachePath = output.trim();
            isFound = !!ccachePath;
        } catch {
            core.warning('ccache could not be installed. Proceeding without ccache.');
        }
    }
    if (isFound) {
        await exec('ccache', ['-s']);
        const runnerTemp = process.env['RUNNER_TEMP'];
        const ccacheBin = `${runnerTemp}/ccache_bin`;
        if (!fs.existsSync(ccacheBin)) {
            fs.mkdirSync(ccacheBin, { recursive: true });
        }
        process.env['CCACHE_BIN'] = ccacheBin;
        const clangPath = path.join(ccacheBin, 'clang');
        const clang_ppPath = path.join(ccacheBin, 'clang++');
        try { fs.unlinkSync(clangPath); } catch { }
        try { fs.unlinkSync(clang_ppPath); } catch { }
        fs.symlinkSync(ccachePath, clangPath);
        fs.symlinkSync(ccachePath, clang_ppPath);
        core.info('ccache is enabled for Xcode builds.');
    } else {
        throw new Error('ccache is not available. Please install ccache to enable caching for Xcode builds.');
    }
}