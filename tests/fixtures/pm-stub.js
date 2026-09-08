// Stands in for the package manager named by npm_execpath: records its argv, fails on request.
import {appendFileSync} from 'node:fs';

const args = process.argv.slice(2);
appendFileSync(process.env.PM_RECORD, JSON.stringify({args, cwd: process.cwd()}) + '\n');
process.exit(process.env.PM_FAIL && args.includes(process.env.PM_FAIL) ? 1 : 0);
