#!/usr/bin/env node
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
await import(require.resolve('lanshare-cli/bin/lannotebook.js'));
