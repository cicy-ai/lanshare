#!/usr/bin/env node
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
const require = createRequire(import.meta.url);
await import(pathToFileURL(require.resolve('lanshare-cli/bin/lannotebook.js')).href);
