const fs = require('node:fs');
const path = require('node:path');
const {createRequire} = require('node:module');
const {buildSync} = createRequire(require.resolve('vite'))('esbuild');
const root = path.resolve(__dirname, '../..');
buildSync({entryPoints:[path.join(root,'tests/thinking-picker-fixture.tsx')],outfile:path.join(root,'build-check/thinking-ui.js'),bundle:true,format:'iife',platform:'browser',jsx:'automatic',define:{'process.env.NODE_ENV':'"production"'}});
fs.writeFileSync(path.join(root,'build-check/thinking-ui.html'),'<!doctype html><html><head><meta charset="UTF-8"><style>body{background:#121315;color:#eee;font:14px sans-serif;padding:12px}.felix-control{display:inline-flex;align-items:center}select{background:#1d1e20;color:#eee;border:1px solid #666;border-radius:7px;padding:8px;font-size:13px;max-width:310px}.felix-chevron{width:12px;margin-left:6px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}</style></head><body><div id="root"></div><script src="thinking-ui.js"></script></body></html>');
console.log('Built isolated thinking UI fixture.');
