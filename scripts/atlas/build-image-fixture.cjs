'use strict';
const path = require('node:path'), fs = require('node:fs');
const { createRequire } = require('node:module');
const { buildSync } = createRequire(require.resolve('vite'))('esbuild');
const root = path.resolve(__dirname, '../..');
const output = path.join(root, 'build-check/chat-image-fixture.js');
fs.mkdirSync(path.dirname(output), { recursive: true });
buildSync({ absWorkingDir: root, entryPoints: ['tests/chat-image-fixture.tsx'], outfile: output,
  bundle: true, format: 'iife', platform: 'browser', jsx: 'automatic', alias: { '@': path.join(root, 'src') },
  define: { 'import.meta.env.DEV': 'false', 'process.env.NODE_ENV': '"production"' } });
console.log(output);
