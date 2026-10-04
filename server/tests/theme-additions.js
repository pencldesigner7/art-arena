'use strict';
// Local app only. Requires Playwright; use NODE_PATH if installed outside repo.
const assert=require('node:assert/strict');
const {randomBytes}=require('node:crypto');
const {chromium}=require('playwright');
const base='http://127.0.0.1:3000';
async function api(token,path,body,status=200,method=body===undefined?'GET':'POST'){
  const r=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const d=await r.json();assert.equal(r.status,status,path+' '+JSON.stringify(d));return d;
}
async function user(){const name='themes_'+randomBytes(5).toString('hex'),password='ThemeTests123!';await api(null,'/auth/register',{username:name,email:name+'@example.test',password},201);return api(null,'/auth/login',{login:name,password});}
(async()=>{
  const owner=await user(),free=await user();
  for(const theme of ['chrome','comic'])await api(free.session_token,'/premium/theme',{theme},403,'PUT');
  await api(owner.session_token,'/premium/test-activate',{});
  let d=await api(owner.session_token,'/premium/themes');assert(d.themes.some(t=>t.key==='chrome'));assert(d.themes.some(t=>t.key==='comic'));
  await api(owner.session_token,'/premium/theme',{theme:'chrome',custom:{finish:'gold',untrusted:'ignored'}},200,'PUT');
  d=await api(owner.session_token,'/premium/themes');assert.deepEqual(d.ui_custom,{finish:'gold'});
  await api(owner.session_token,'/premium/theme',{theme:'comic'},200,'PUT');
  await api(owner.session_token,'/premium/theme',{theme:'chrome'},200,'PUT');
  d=await api(owner.session_token,'/premium/themes');assert.equal(d.ui_custom.finish,'gold');
  d=await api(free.session_token,'/users/'+owner.user.id+'/profile');assert.equal(d.user.ui_theme,'chrome');assert.equal(d.user.ui_custom.finish,'gold');
  console.log('PASS catalog, premium enforcement, finish whitelist, per-theme persistence, owner-profile API');
  const browser=await chromium.launch({args:['--enable-unsafe-swiftshader']});const errors=[];const missing=[];
  try{
    const ctx=await browser.newContext({viewport:{width:1280,height:900}});
    await ctx.addInitScript(token=>{sessionStorage.setItem('arena_session_token',token);window.entryStarts=0;document.addEventListener('animationstart',e=>{if(e.animationName==='aa-entry-mark')window.entryStarts++;});},owner.session_token);
    const p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));p.on('response',r=>{if(r.status()===404)missing.push(r.url());});
    await p.goto(base);await p.waitForFunction(()=>typeof activeThemeKey!=='undefined'&&activeThemeKey==='chrome'&&!!homeBgScene?.program);await p.waitForTimeout(1700);
    assert.equal(await p.evaluate(()=>document.body.dataset.finish),'gold');
    assert((await p.locator('link[rel="icon"]').getAttribute('href')).includes('chrome-gold-icon'));
    assert.equal(await p.locator('.aa-chrome-canvas').count(),1);
    await p.evaluate(()=>show('settings'));await p.waitForSelector('#chrome-finish:not(.hidden)');
    await p.locator('[data-chrome-finish="chrome"]').click();await p.waitForFunction(()=>activeThemeCustom?.finish==='chrome');
    await p.locator('[data-chrome-finish="gold"]').click();await p.waitForFunction(()=>activeThemeCustom?.finish==='gold');
    assert.equal(await p.evaluate(()=>window.entryStarts),1);
    await p.reload();await p.waitForFunction(()=>typeof activeThemeCustom!=='undefined'&&activeThemeCustom?.finish==='gold');
    await p.evaluate(()=>show('settings'));await p.waitForSelector('[data-settings-theme="comic"]');
    await p.locator('[data-settings-theme="comic"]').click();await p.waitForFunction(()=>activeThemeKey==='comic'&&!!document.querySelector('.aa-comic-scene'));
    assert.equal(await p.locator('.aa-chrome-canvas').count(),0);assert.equal(await p.locator('.aa-comic-scene').count(),1);
    assert((await p.locator('link[rel="icon"]').getAttribute('href')).includes('comic-icon'));
    await p.evaluate(()=>show('arena'));await p.waitForTimeout(1700);assert.equal(await p.evaluate(()=>window.entryStarts),1);
    for(const mode of ['light','dark']){
      await p.evaluate(mode=>applyTheme(mode),mode);
      assert.equal(await p.evaluate(()=>document.documentElement.dataset.theme),mode);
      assert.equal(await p.locator('.aa-comic-scene').count(),1);
      assert.equal(await p.evaluate(()=>window.entryStarts),1);
    }
    await p.evaluate(()=>setAnimations(false));assert(await p.locator('.aa-comic-scene').evaluate(e=>e.classList.contains('still')));
    await p.evaluate(()=>setAnimations(true));
    await p.emulateMedia({reducedMotion:'reduce'});await p.waitForFunction(()=>document.querySelector('.aa-comic-scene').classList.contains('still'));
    await p.emulateMedia({reducedMotion:'no-preference'});await p.waitForFunction(()=>!document.querySelector('.aa-comic-scene').classList.contains('still'));
    for(const [key,custom] of [['chrome',{finish:'chrome'}],['chrome',{finish:'gold'}],['comic',null]]){
      await p.evaluate(([k,c])=>applyPremiumTheme(k,c),[key,custom]);
      if(key==='chrome'){
        await p.waitForFunction(()=>!!homeBgScene?.program);
        if(custom.finish==='chrome'){
          await p.evaluate(()=>{window.testContext=homeBgScene.gl.getExtension('WEBGL_lose_context');window.testContext.loseContext();});
          await p.waitForFunction(()=>homeBgScene.lost===true);
          await p.evaluate(()=>window.testContext.restoreContext());
          await p.waitForFunction(()=>!homeBgScene.lost&&!!homeBgScene.program);
          await p.evaluate(()=>delete window.testContext);
        }
        const running=await p.evaluate(()=>homeBgScene.time);await p.waitForFunction(t=>homeBgScene.time>t,running,{timeout:10000});
        await p.evaluate(()=>setAnimations(false));const paused=await p.evaluate(()=>homeBgScene.time);await p.waitForTimeout(100);assert.equal(await p.evaluate(()=>homeBgScene.time),paused);await p.evaluate(()=>setAnimations(true));
      }
    }
    // Every supplied brandmark resolves to a real PNG, and theme changes do not replay entry.
    for(const key of ['flame','cloud','chrome','comic','glitch','pixel','magazine']){
      await p.evaluate(k=>window.ArenaBrandmarks.set(k,null),key);
      const href=await p.locator('link[rel="icon"]').getAttribute('href');const r=await fetch(new URL(href,base));assert.equal(r.status,200);assert(r.headers.get('content-type').includes('image/png'));
    }
    // Profile owner theme remains independent of the viewing account.
    const fc=await browser.newContext();await fc.addInitScript(token=>sessionStorage.setItem('arena_session_token',token),free.session_token);const fp=await fc.newPage();fp.on('pageerror',e=>errors.push(e.message));await fp.goto(base);await fp.waitForFunction(()=>typeof me!=='undefined'&&!!me);
    for(const [key,custom] of [['chrome',{finish:'gold'}],['comic',null]]){
      await api(owner.session_token,'/premium/theme',{theme:key,custom},200,'PUT');
      await fp.evaluate(id=>openProfile(id),owner.user.id);await fp.waitForFunction(key=>document.querySelector('.prof-modal-card').dataset.profTheme===key,key);
      assert.equal(await fp.evaluate(()=>activeThemeKey),null);
      const image=await fp.locator('.prof-modal-card').evaluate(e=>getComputedStyle(e).backgroundImage);assert(image.includes('profile-'+key));
      if(key==='chrome')assert.equal(await fp.locator('.prof-modal-card').getAttribute('data-finish'),'gold');
    }
    await p.setViewportSize({width:390,height:844});await p.evaluate(()=>{applyPremiumTheme('comic',null);show('arena');});
    assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
    // WebGL-unavailable fallback must remain usable, not a black/empty canvas.
    const fallback=await browser.newContext();await fallback.addInitScript(()=>{const get=HTMLCanvasElement.prototype.getContext;HTMLCanvasElement.prototype.getContext=function(kind,...args){return kind==='webgl'?null:get.call(this,kind,...args);};});const f=await fallback.newPage();await f.goto(base);await f.waitForTimeout(100);await f.evaluate(()=>applyPremiumTheme('chrome',{finish:'gold'}));
    assert((await f.locator('.aa-chrome-canvas').evaluate(e=>getComputedStyle(e).backgroundImage)).includes('linear-gradient'));
    assert.deepEqual(errors,[]);assert.deepEqual(missing,[]);
    console.log('PASS finish toggle/reload, themed favicons, one scene, shader motion/pause/fallback, Comic dark/light/reduced motion, mobile, owner-scoped profiles; no JS errors/404s');
  }finally{await browser.close();}
  await api(owner.session_token,'/premium/test-revoke',{});
  d=await api(owner.session_token,'/premium/themes');assert.equal(d.ui_theme,null);
  console.log('PASS premium revocation restores default theme');
})().catch(e=>{console.error(e);process.exitCode=1;});
