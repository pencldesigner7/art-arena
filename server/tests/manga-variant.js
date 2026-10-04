'use strict';
// Run against the disposable local app, never production.
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
const {randomBytes}=require('node:crypto');
const base='http://127.0.0.1:3000';
async function api(token,path,body,status=200,method=body===undefined?'GET':'POST'){
 const r=await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});const d=await r.json();assert.equal(r.status,status,JSON.stringify(d));return d;
}
async function user(){const name='manga_'+randomBytes(5).toString('hex'),password='MangaTests123!';await api(null,'/auth/register',{username:name,email:name+'@example.test',password},201);return api(null,'/auth/login',{login:name,password});}
(async()=>{
 const owner=await user(),free=await user(),token=owner.session_token;
 await api(free.session_token,'/premium/theme',{theme:'comic',custom:{finish:'manga'}},403,'PUT');
 await api(token,'/premium/test-activate',{});
 await api(token,'/premium/theme',{theme:'comic',custom:{finish:'manga',c1:'#ff0000'}},200,'PUT');
 let d=await api(token,'/premium/themes');assert.deepEqual(d.ui_custom,{finish:'manga'});assert(!d.themes.some(t=>t.key==='manga'));
 await api(token,'/premium/theme',{theme:'chrome',custom:{finish:'gold'}},200,'PUT');await api(token,'/premium/theme',{theme:'comic'},200,'PUT');d=await api(token,'/premium/themes');assert.equal(d.ui_custom.finish,'manga');
 const b=await chromium.launch({args:['--enable-unsafe-swiftshader']});const errors=[];
 try{
 const ctx=await b.newContext({viewport:{width:1280,height:900}});await ctx.addInitScript(t=>sessionStorage.setItem('arena_session_token',t),token);
 const p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));p.on('response',r=>{if(r.status()===404)errors.push(r.url());});await p.goto(base);await p.waitForFunction(()=>document.body.dataset.finish==='manga'&&!!document.querySelector('.aa-comic-scene.manga'));
 assert.equal(await p.locator('.aa-comic-scene img').count(),5);assert((await p.locator('link[rel="icon"]').getAttribute('href')).includes('comic-manga-icon'));
 assert((await p.locator('.home-logo img').getAttribute('src')).includes('comic-manga.png'));
 await p.evaluate(()=>show('settings'));await p.waitForSelector('#comic-finish:not(.hidden)');assert(await p.locator('#chrome-finish').evaluate(e=>e.classList.contains('hidden')));
 await p.locator('[data-comic-finish="comic"]').click();await p.waitForFunction(()=>document.body.dataset.finish==='comic');assert.equal(await p.locator('.aa-comic-scene img').count(),7);
 await p.locator('[data-comic-finish="manga"]').click();await p.waitForFunction(()=>document.body.dataset.finish==='manga');await p.reload();await p.waitForFunction(()=>document.body.dataset.finish==='manga'&&!!document.querySelector('.aa-comic-scene.manga'));
 await p.evaluate(()=>setAnimations(false));assert(await p.locator('.aa-comic-scene').evaluate(e=>e.classList.contains('still')));await p.evaluate(()=>setAnimations(true));await p.emulateMedia({reducedMotion:'reduce'});await p.waitForFunction(()=>document.querySelector('.aa-comic-scene').classList.contains('still'));await p.emulateMedia({reducedMotion:'no-preference'});
 for(const mode of ['dark','light']){await p.evaluate(m=>{applyTheme(m);show('arena');},mode);await p.waitForTimeout(4200);assert.equal(await p.locator('.aa-comic-scene').count(),1);await p.screenshot({path:'/home/user/theme-previews/Manga-'+mode+'.png'});}
 await p.evaluate(()=>openProfile(me.id));await p.waitForFunction(()=>document.querySelector('#pm-card').dataset.finish==='manga');await p.waitForTimeout(400);await p.screenshot({path:'/home/user/theme-previews/Manga-profile.png'});
 const viewer=await b.newContext();await viewer.addInitScript(t=>sessionStorage.setItem('arena_session_token',t),free.session_token);const fp=await viewer.newPage();await fp.goto(base);await fp.waitForFunction(()=>typeof me!=='undefined'&&!!me);await fp.evaluate(id=>openProfile(id),owner.user.id);await fp.waitForFunction(()=>document.querySelector('#pm-card').dataset.finish==='manga');assert.equal(await fp.evaluate(()=>activeThemeKey),null);assert((await fp.locator('#pm-card').evaluate(e=>getComputedStyle(e).backgroundImage)).includes('profile-manga.jpg'));
 await p.evaluate(()=>{modalClose('#profile-modal');show('settings');});await p.setViewportSize({width:390,height:844});await p.waitForTimeout(400);assert(await p.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 assert.deepEqual(errors,[]);
 }finally{await b.close();}
 await api(token,'/premium/theme',{theme:'comic',custom:{finish:'invalid'}},200,'PUT');d=await api(token,'/premium/themes');assert.equal(d.ui_custom.finish,'comic');
 console.log('PASS Manga: premium gate, finish sanitizer, no separate theme, persistence, UI toggle/reload, 5/7 stickers, monochrome logo/favicon, one scene, motion/reduced-motion, owner perspective, mobile, no JS errors/404s');
})().catch(e=>{console.error(e);process.exitCode=1});
