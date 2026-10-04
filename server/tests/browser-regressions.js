'use strict';
// NODE_PATH pointing to Playwright is sufficient; production dependencies unchanged.
const { chromium } = require('playwright');
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const base='http://127.0.0.1:3000';
async function request(token,path,body) {
  const r=await fetch(base+'/api'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const d=await r.json();assert(r.ok,JSON.stringify(d));return d;
}
async function newUser(){const name='browser_'+randomBytes(4).toString('hex'),password='BrowserTest123!';await request(null,'/auth/register',{username:name,email:name+'@example.test',password});return request(null,'/auth/login',{login:name,password});}
(async()=>{
  const browser=await chromium.launch({headless:true});
  try {
    const page=await browser.newPage();const errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{window.entryStarts=0;document.addEventListener('animationstart',e=>{if(e.animationName==='aa-entry-mark')window.entryStarts++;});});
    await page.goto(base);await page.waitForTimeout(1700);
    assert.equal(await page.evaluate(()=>window.entryStarts),1);
    await page.evaluate(()=>{applyPremiumTheme('glowing',null);show('settings');show('login');document.documentElement.setAttribute('data-theme','light');});
    await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.entryStarts),1);
    for(const mode of ['dark','light']) {
      await page.evaluate(mode=>{document.documentElement.setAttribute('data-theme',mode);},mode);
      const filter=await page.locator('img[data-aa-logo]').first().evaluate(e=>getComputedStyle(e).filter);
      assert(filter.includes('drop-shadow'));
      // Inspect the real CSS selector on a local iframe; external video requires OAuth/network.
      const bg=await page.evaluate(()=>{const box=document.createElement('div');box.className='tw-embed';const frame=document.createElement('iframe');box.append(frame);document.body.append(box);const r={container:getComputedStyle(box).backgroundColor,frame:getComputedStyle(frame).backgroundColor};box.remove();return r;});
      assert.equal(bg.container,'rgb(0, 0, 0)');assert.equal(bg.frame,'rgb(0, 0, 0)');
    }
    await page.reload();await page.waitForTimeout(1700);assert.equal(await page.evaluate(()=>window.entryStarts),1);
    // pageshow restoration path (deterministic synthetic event, not a BFCache guarantee).
    await page.evaluate(()=>window.dispatchEvent(new PageTransitionEvent('pageshow',{persisted:true})));
    await page.waitForTimeout(100);assert.equal(await page.evaluate(()=>window.entryStarts),2);
    await page.emulateMedia({reducedMotion:'reduce'});await page.reload();await page.waitForTimeout(400);
    assert.equal(await page.locator('#aa-entry').evaluate(e=>getComputedStyle(e).visibility),'hidden');
    console.log('PASS document entry/reload, no theme/navigation replay, restore handler, reduced motion, opaque Twitch surfaces and sharp glow');
    const ua=await newUser(),ub=await newUser();
    const c=await request(ua.session_token,'/rooms',{name:'Browser regression',drawing_app_key:'krita',battle_type:'none'});
    await request(ub.session_token,'/rooms/'+c.code+'/join',{drawing_app_key:'krita'});
    const clients=[];
    for(const u of [ua,ub]){
      const ctx=await browser.newContext();await ctx.addInitScript(token=>sessionStorage.setItem('arena_session_token',token),u.session_token);
      const p=await ctx.newPage();p.on('pageerror',e=>errors.push(e.message));await p.goto(base);await p.waitForFunction(()=>typeof me!=='undefined'&&me);await p.evaluate(code=>openRoom(code),c.code);await p.waitForSelector('#btn-ready:not(.hidden)');clients.push(p);
    }
    const [a,b]=clients;
    await request(ua.session_token,'/rooms/'+c.code+'/transfer-ownership',{user_id:ub.user.id});
    await a.waitForFunction(id=>lastRoomData.host.user_id===id,ub.user.id);
    await b.waitForFunction(id=>lastRoomData.host.user_id===id,ub.user.id);
    assert(await a.locator('#btn-start').evaluate(e=>e.classList.contains('hidden')));
    assert(!await b.locator('#btn-start').evaluate(e=>e.classList.contains('hidden')));
    await request(ub.session_token,'/rooms/'+c.code+'/transfer-ownership',{user_id:ua.user.id});
    await a.waitForFunction(id=>lastRoomData.host.user_id===id,ua.user.id);
    await b.waitForFunction(id=>lastRoomData.host.user_id===id,ua.user.id);
    await a.locator('#btn-ready').click();await a.waitForFunction(()=>lastRoomData.players.find(p=>p.is_you).state==='ready');
    const blocked=await a.evaluate(async code=>{const r=await fetch('/api/rooms/'+code+'/start',{method:'POST',headers:{Authorization:'Bearer '+sessionStorage.getItem('arena_session_token'),'Content-Type':'application/json'},body:'{}'});return r.status;},c.code);assert.equal(blocked,409);
    await b.locator('#btn-ready').click();await b.waitForFunction(()=>lastRoomData.players.find(p=>p.is_you).state==='ready');
    await request(ua.session_token,'/rooms/'+c.code+'/start',{});
    await a.waitForFunction(()=>lastRoomData.battle&&lastRoomData.battle.status==='challenge_locked');
    await b.waitForFunction(()=>lastRoomData.battle&&lastRoomData.battle.status==='challenge_locked');
    assert(await b.locator('#btn-reroll').evaluate(e=>e.classList.contains('hidden')));
    assert(await b.locator('#rv-reroll').evaluate(e=>e.classList.contains('hidden')));
    await a.evaluate(()=>{revealClose();window.revealStarts=0;document.getElementById('reveal-view').addEventListener('animationstart',()=>window.revealStarts++);revealOpen(lastRoomData,true);});
    await a.waitForTimeout(300);const starts=await a.evaluate(()=>window.revealStarts);assert(starts>0);
    await a.evaluate(()=>{revealSync(lastRoomData);applyPremiumTheme(null,null);});await a.waitForTimeout(1900);
    await a.evaluate(()=>{revealClose();revealOpen(lastRoomData,true);});await a.waitForTimeout(300);assert(await a.evaluate(()=>window.revealStarts)>starts);
    await request(ua.session_token,'/rooms/'+c.code+'/leave',{});await request(ub.session_token,'/rooms/'+c.code+'/leave',{});
    assert.deepEqual(errors,[]);
    console.log('PASS two real browser sessions: Ready gating, realtime battle sync, non-owner reroll hidden, reveal re-entry, zero JS exceptions');
  } finally {await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1;});
