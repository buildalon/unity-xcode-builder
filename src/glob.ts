import { glob } from 'glob';
import * as fs from 'fs';
import * as path from 'path';

export interface GlobOptions {
    /** include directories in the results; defaults to true */
    matchDirectories?: boolean;
    /** a matched directory also matches everything under it; defaults to true */
    implicitDescendants?: boolean;
}

export interface Globber {
    glob(): Promise<string[]>;
}

/**
 * The part of @actions/glob these actions use, on glob v13: newline separated patterns, `!` excludes and `#` comments.
 * @actions/glob pins a minimatch with a published advisory, and its fix needs minimatch 11, which @actions/glob can't run on.
 */
export async function create(patterns: string, options: GlobOptions = {}): Promise<Globber> {
    return { glob: () => match(patterns, options) };
}

async function match(patterns: string, options: GlobOptions): Promise<string[]> {
    const lines = patterns.split(/\r?\n/).map(line => line.trim()).filter(line => line.length > 0 && !line.startsWith('#'));
    const include = lines.filter(line => !line.startsWith('!'));
    const ignore = lines.filter(line => line.startsWith('!')).map(line => line.substring(1).trim());
    if (include.length === 0) { return []; }
    const matchDirectories = options.matchDirectories ?? true;
    const implicitDescendants = options.implicitDescendants ?? true;
    const globOptions = {
        absolute: true,
        dot: true,
        ignore: ignore.flatMap(pattern => [pattern, `${pattern}/**`]),
        // backslashes are path separators on Windows, as in @actions/glob
        windowsPathsNoEscape: true
    };
    const found = new Set(await glob(include, globOptions));
    if (implicitDescendants) {
        for (const descendant of await glob(include.map(pattern => `${pattern}/**`), globOptions)) {
            found.add(descendant);
        }
    }
    const results: string[] = [];
    for (const file of found) {
        if (!matchDirectories) {
            try {
                if ((await fs.promises.stat(file)).isDirectory()) { continue; }
            } catch {
                continue;
            }
        }
        results.push(path.resolve(file));
    }
    return results.sort();
}
