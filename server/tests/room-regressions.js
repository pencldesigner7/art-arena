'use strict';
// Run only against a disposable LOCAL database and the local production server.
// DATABASE_URL=postgresql://...@127.0.0.1/... node server/tests/room-regressions.js
const assert = require('node:assert/strict');
const { randomBytes } = require('node:crypto');
const db = new URL(process.env.DATABASE_URL || 'http://missing');
assert(['localhost','127.0.0.1'].includes(db.hostname), 'Local disposable DATABASE_URL required');
const { pool } = require('../lib');
const { finishBattleIfDue } = require('../battle-end');
const { WebSocket } = require('ws');
const base = 'http://127.0.0.1:3000';
async function api(u, path, body, status=200, method=body === undefined ? 'GET' : 'POST') {
  const r = await fetch(base+'/api'+path,{method,headers:{'Content-Type':'application/json',...(u?{Authorization:'Bearer '+u.token}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const d=await r.json(); assert.equal(r.status,status,path+' '+JSON.stringify(d)); return d;
}
const users=[], rooms=new Set();
async function user() {
  const name='reg_'+randomBytes(6).toString('hex'), password='RegressionTest123!';
  const d=await api(null,'/auth/register',{username:name,email:name+'@example.test',password},201);
  const login=await api(null,'/auth/login',{login:name,password});
  const u={id:d.user.id,token:login.session_token,name};users.push(u);return u;
}
async function room(u, mode='1v1') {
  const d=await api(u,'/rooms',{name:'Regression',battle_mode:mode,max_players:mode==='3v3'?6:2,drawing_app_key:'krita',battle_type:'none'},201); rooms.add(d.code);return d.code;
}
const path=(c,a='')=>'/rooms/'+c+a;
async function main() {
  const a=await user(), b=await user();
  let c=await room(a);
  await api(b,path(c,'/join'),{drawing_app_key:'krita'});
  await api(a,path(c,'/ready'),{});
  await api(a,path(c,'/start'),{},409);
  assert.equal((await api(a,path(c))).status,'lobby');
  await api(b,path(c,'/transfer-ownership'),{user_id:a.id},403);
  await api(a,path(c,'/transfer-ownership'),{user_id:b.id});
  await api(a,path(c,'/kick'),{user_id:b.id},403);
  await api(a,path(c,'/start'),{},403);
  await api(b,path(c,'/ready'),{});
  let d=await api(b,path(c,'/start'),{});
  await api(a,path(c,'/challenge/reroll'),{},403);
  await api(b,'/premium/test-activate',{});
  await api(b,path(c,'/challenge/reroll'),{});
  console.log('PASS Ready gate, transfer, stale-owner rejection, premium/owner re-roll');
  await api(b,path(c,'/launch'),{});
  // Advance only this fixture's clock; run the real battle completion engine.
  await pool.query("UPDATE battles SET status='active', start_time=now()-interval '2 minutes', official_end_time=now()-interval '1 second' WHERE id=$1",[d.battle.id]);
  await finishBattleIfDue(d.battle.id);
  await api(a,path(c,'/rematch'),{});
  d=await api(b,path(c,'/rematch/accept'),{});
  assert.equal(d.host.user_id,a.id);
  assert(d.players.every(p=>p.state==='ready'));
  assert.equal((await api(b,path(c))).host.user_id,a.id);
  await api(a,path(c,'/leave'),{}); // pre-launch leave cancels and releases the seat
  d=await api(b,path(c));assert.equal(d.status,'lobby');assert.equal(d.host.user_id,b.id);
  await api(b,path(c,'/leave'),{});
  console.log('PASS rematch requester ownership, consent, pre-launch leave and owner succession');
  // Auto-start matchmaking cannot treat picking a canvas as Ready.
  await api(a,'/matchmaking/enter',{mode:'1v1'});
  d=await api(b,'/matchmaking/enter',{mode:'1v1'});c=d.room;rooms.add(c);
  for(const u of [a,b]) await api(u,path(c,'/canvas'),{drawing_app_key:'krita'});
  assert.equal((await api(a,path(c))).status,'lobby');
  await api(a,path(c,'/ready'),{});assert.equal((await api(a,path(c))).status,'lobby');
  await api(b,path(c,'/ready'),{});assert.equal((await api(a,path(c))).battle.status,'challenge_locked');
  for(const u of [a,b]) await api(u,path(c,'/leave'),{});
  console.log('PASS automatic rooms wait for both explicit Ready actions');
  const six=[a,b];while(six.length<6)six.push(await user());
  for(let i=0;i<5;i++) {
    const q=await api(six[i],'/matchmaking/enter',{mode:'3v3'});assert.equal(q.matched,false);
    const occupied=await pool.query("SELECT 1 FROM room_participants WHERE user_id=$1 AND state IN ('waiting','ready')",[six[i].id]);assert.equal(occupied.rowCount,0);
  }
  d=await api(six[5],'/matchmaking/enter',{mode:'3v3'});assert(d.matched);c=d.room;rooms.add(c);
  const snapshots=await Promise.all(six.map(u=>api(u,path(c))));
  for(const r of snapshots) {assert.equal(r.origin,'matchmaking');assert.equal(r.players.length,6);assert.deepEqual(r.players.map(p=>p.seat).sort(),[1,2,3,4,5,6]);}
  const host=six.find(u=>u.id===snapshots[0].host.user_id);
  await api(host,path(c,'/kick'),{user_id:six.find(u=>u!==host).id},403);
  await api(host,path(c,'/transfer-ownership'),{user_id:six.find(u=>u!==host).id},403);
  await api(host,path(c),{},403,'DELETE');
  await api(host,path(c,'/close'),{},403);
  await api(host,path(c),{name:'Forbidden'},403,'PATCH');
  await api(host,path(c,'/randomizer-config'),{categories:['character']},409);
  for(const u of six) await api(u,path(c,'/canvas'),{drawing_app_key:'krita'});
  for(const u of six.slice(0,5)) await api(u,path(c,'/ready'),{});
  await api(host,path(c,'/start'),{},409);
  await api(six[5],path(c,'/ready'),{});
  await api(host,path(c,'/start'),{});
  for(const u of six) {await api(u,path(c,'/leave'),{});const q=await api(u,'/matchmaking/status');assert.equal(q.match,null);}
  console.log('PASS 3v3 queue 1–5 blocked; six seats/two teams; all-ready gate; all six leave; no stale claims');
  // Created room discovered via matchmaking remains created; plus buttons not involved.
  c=await room(a,'3v3');
  d=await api(b,'/matchmaking/enter',{mode:'3v3'});assert.equal(d.room,c);
  d=await api(b,path(c));assert.equal(d.origin,'created');assert.equal(d.host.user_id,a.id);
  await api(b,path(c,'/kick'),{user_id:a.id},403);
  await api(b,path(c,'/close'),{},403);
  await api(b,path(c),{},403,'DELETE');
  await api(b,path(c),{name:'Forbidden'},403,'PATCH');
  await api(a,path(c,'/kick'),{user_id:b.id});
  await api(a,path(c,'/transfer-ownership'),{user_id:b.id},409);
  for(const u of six.slice(1))await api(u,path(c,'/join'),{drawing_app_key:'krita'});
  assert.equal((await api(a,path(c))).players.length,6);
  for(const u of six)await api(u,path(c,'/leave'),{});
  console.log('PASS created-room origin, kick restrictions, left-target rejection, six natural joins');
  // Real notification acceptance while queued must not publish an undersized room.
  await api(a,'/matchmaking/enter',{mode:'3v3'});
  const invite=await pool.query("INSERT INTO notifications(user_id,type,payload) VALUES ($1,'mm_team_invite',$2::jsonb) RETURNING id",[b.id,JSON.stringify({from_user_id:a.id})]);
  d=await api(b,'/matchmaking/team-invite/'+invite.rows[0].id+'/accept',{});assert.equal(d.in_queue,true);assert.equal(d.room,null);
  for(const u of six.slice(2))d=await api(u,'/matchmaking/enter',{mode:'3v3'});
  assert(d.matched);c=d.room;rooms.add(c);d=await api(a,path(c));
  const seats=[a,b].map(u=>d.players.find(p=>p.user_id===u.id).seat);assert.equal(seats[0]<=3,seats[1]<=3);
  // Capture authenticated websocket broadcasts from the existing realtime hub.
  const ws=new WebSocket('ws://127.0.0.1:3000/api/realtime?arena_token='+a.token);
  const events=[];ws.on('message',raw=>events.push(JSON.parse(raw)));
  await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject);});
  ws.send(JSON.stringify({type:'subscribe',room:c}));
  await new Promise(r=>setTimeout(r,100));
  await api(b,path(c,'/ready'),{});
  await new Promise(r=>setTimeout(r,100));
  assert(events.some(e=>e.type==='room.event'&&e.event.action==='ready'));ws.close();
  for(const u of six)await api(u,path(c,'/leave'),{});
  console.log('PASS optional invited teammates stay together; authenticated realtime ready event');
  for(const provider of ['twitch','youtube']){await api(a,'/'+provider+'/status');await api(a,'/'+provider+'/connection');}
  await api(a,'/live');
  console.log('PASS Twitch/YouTube connection-status and live-list routes (no external OAuth credentials)');
}
main().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{
  // Only this run's fixtures; never point this test at a shared database.
  for(const c of rooms){
    await pool.query("UPDATE battles SET status='cancelled' WHERE room_id IN (SELECT id FROM battle_rooms WHERE code=$1) AND status <> 'complete'",[c]);
    await pool.query("UPDATE room_participants SET state='left',ready_at=NULL,left_at=now() WHERE room_id IN (SELECT id FROM battle_rooms WHERE code=$1)",[c]);
    await pool.query("UPDATE battle_rooms SET status='ended',ended_at=now() WHERE code=$1",[c]);
  }
  for(const u of users)await pool.query("UPDATE matchmaking_queue SET status='cancelled' WHERE user_id=$1 AND status IN ('queued','matched')",[u.id]);
  await pool.end();
});
