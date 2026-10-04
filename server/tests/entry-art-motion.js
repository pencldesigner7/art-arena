'use strict';
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{const b=await chromium.launch();try{
 const p=await b.newPage();const errors=[];p.on('pageerror',e=>errors.push(e.message));p.on('response',r=>{if(r.status()===404)errors.push(r.url());});
 await p.addInitScript(()=>{window.entryStarts=0;document.addEventListener('animationstart',e=>{if(e.animationName==='aa-entry-mark')entryStarts++;});});
 await p.goto('http://127.0.0.1:3000');await p.waitForTimeout(1700);assert.equal(await p.evaluate(()=>entryStarts),1);
 for(const key of ['graffiti','glowing','flame']){await p.evaluate(k=>applyPremiumTheme(k,null),key);assert((await p.locator('link[rel="icon"]').getAttribute('href')).includes(key+'-icon'));await p.locator('#aa-entry img').evaluate(im=>im.decode());assert.equal(await p.locator('#aa-entry').getAttribute('data-mark'),key);if(key!=='graffiti')assert((await p.locator('#aa-entry img').evaluate(e=>getComputedStyle(e).filter)).includes('drop-shadow'));}
 assert.equal(await p.evaluate(()=>entryStarts),1);
 await p.evaluate(()=>dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));await p.waitForTimeout(100);assert.equal(await p.evaluate(()=>entryStarts),2);
 assert.equal(await p.locator('#aa-entry').evaluate(e=>getComputedStyle(e,'::after').content),'none');
 await p.waitForTimeout(1600);assert.equal(await p.locator('#aa-entry').evaluate(e=>getComputedStyle(e).visibility),'hidden');
 for(const finish of ['comic','manga']){
  await p.evaluate(f=>applyPremiumTheme('comic',{finish:f}),finish);await p.waitForSelector('.aa-comic-scene');
  assert.equal(await p.locator('.aa-comic-scene img').count(),finish==='comic'?7:5);
  const wall=()=>p.locator('.aa-comic-scene').evaluate(e=>getComputedStyle(e,'::before').transform);
  const a=await wall();await p.waitForTimeout(160);assert.notEqual(await wall(),a);
  assert.equal(await p.locator('.aa-comic-scene img').first().evaluate(e=>getComputedStyle(e).animationName),finish==='comic'?'aa-comic-impact':'aa-comic-pop');
  assert.equal(await p.locator('.aa-comic-scene img').first().evaluate(e=>getComputedStyle(e).animationDuration),'22s');
  assert.equal(await p.locator('.aa-comic-scene').evaluate(e=>getComputedStyle(e).transform),'none');
  if(finish==='comic')await p.locator('img[src="/themes/comic/pow.png"]').evaluate(im=>im.decode());
  await p.evaluate(()=>setAnimations(false));assert.equal(await p.locator('.aa-comic-scene').evaluate(e=>getComputedStyle(e,'::before').animationName),'none');await p.evaluate(()=>setAnimations(true));
  await p.emulateMedia({reducedMotion:'reduce'});await p.waitForFunction(()=>document.querySelector('.aa-comic-scene').classList.contains('still'));assert.equal(await p.locator('.aa-comic-scene').evaluate(e=>getComputedStyle(e,'::before').animationName),'none');await p.emulateMedia({reducedMotion:'no-preference'});
 }
 assert.deepEqual(errors,[]);console.log('PASS new brandmarks/favicons/glows, entry once/restoration/no theme replay, POW, independent wall/sticker motion, reduced motion; no JS errors/404s');
 }finally{await b.close();}})().catch(e=>{console.error(e);process.exitCode=1});
