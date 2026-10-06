'use strict';
const path=require('node:path'),{createRequire}=require('node:module'),{buildSync}=createRequire(require.resolve('vite'))('esbuild');
const root=path.resolve(__dirname,'../..');
buildSync({entryPoints:[path.join(root,'tests/composer-toolbar-fixture.tsx')],outfile:path.join(root,'build-check/composer-toolbar-fixture.js'),bundle:true,format:'iife',platform:'browser',jsx:'automatic',alias:{'@':path.join(root,'src')},define:{'import.meta.env.DEV':'false','process.env.NODE_ENV':'"production"'},logLevel:'warning'});
console.log('Built isolated composer toolbar fixture.');
