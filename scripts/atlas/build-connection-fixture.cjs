'use strict';
const path=require('node:path'),{createRequire}=require('node:module'),{buildSync}=createRequire(require.resolve('vite'))('esbuild');
const root=path.resolve(__dirname,'../..');
buildSync({entryPoints:[path.join(root,'tests/connection-ui-fixture.tsx')],outfile:path.join(root,'build-check/connection-ui-fixture.js'),bundle:true,format:'iife',platform:'browser',jsx:'automatic',alias:{'@':path.join(root,'src')},define:{'import.meta.env.DEV':'false','process.env.NODE_ENV':'"production"'},logLevel:'warning'});
console.log('Built isolated connection/status UI fixture.');
