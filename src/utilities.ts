
import core = require('@actions/core');

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
