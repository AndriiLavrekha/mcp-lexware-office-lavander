import { readFileSync } from 'fs';
import { join } from 'path';

// Assumes compiled output lives one directory below the package root (build/version.js).
const packageJson = JSON.parse(
	readFileSync(join(import.meta.dirname, '..', 'package.json'), 'utf8'),
) as { version: string };

export const VERSION: string = packageJson.version;
