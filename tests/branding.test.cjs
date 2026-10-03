'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {brandText,transform}=require('../scripts/atlas/branding.cjs');
test('visible text is branded while stored paths and bridge protocols remain compatible',()=>{
 assert.equal(brandText('modmixer · idle'),'Atlas · idle');
 assert.equal(brandText(" mods you've built in Modmixer.")," mods you've built in Atlas.");
 assert.equal(brandText('modmixer '),'Atlas ');
 for(const value of ['modmixer:oauth:event','modmixer-asset://preview/mod','modmixer.bridge','.modmixer/schematic.json','ModMixer.Live.LiveState','ModmixerBridge','https://modmixer.com','vendor/modmixer-live'])assert.equal(brandText(value),value);
 const code='const a="modmixer · idle",b="modmixer:oauth:event",c=`Modmixer was interrupted. ${42}`;';
 const changed=transform(code);assert(changed.includes('Atlas · idle'));assert(changed.includes('modmixer:oauth:event'));assert(changed.includes('Atlas was interrupted.'));
});
test('OpenAI and Claude share an Atlas local callback page with escaped error details',async()=>{
 const {oauthSuccessHtml,oauthErrorHtml}=await import('../src/atlas/oauth-page.mjs');
 for(const name of ['OpenAI','Anthropic']){
  const html=oauthSuccessHtml(name+' authentication completed.');assert(html.includes('<title>Atlas'));assert(html.includes(name+' authentication completed.'));assert(html.includes('Return to Atlas'));assert(!/modmixer|lebek|<script/i.test(html));
 }
 const html=oauthErrorHtml('<script>test</script>','<img src=x onerror=bad>');assert(html.includes('&lt;script&gt;'));assert(html.includes('&lt;img'));assert(html.includes("default-src 'none'"));
});
