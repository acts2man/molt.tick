import { runWorker, configFromEnv } from './worker.js';
const once = process.argv.includes('--once');
runWorker(configFromEnv(), { once });
