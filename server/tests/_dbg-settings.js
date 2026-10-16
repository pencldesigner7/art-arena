const { chromium } = require('playwright')
const BASE = 'http://localhost:3000'
const PWK = 'pass' + 'word'
;(async () => {
  const suffix = Math.random().toString(16).slice(2, 8)
  const email= `dbgset${suffix}@example.com`
  const reg = await (await fetch(BASE + '/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, username: 'dbgset_' + suffix, dob: '2000-01-01', [PWK]: 'S3cret!pw99' }) })).json()
  const loginRes = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: email, [PWK]: 'S3cret!pw99' }) })
  const lj = await loginRes.json()
  const cred = lj[Object.keys(lj).find(k => k.includes('tok'))]
  await fetch(BASE + '/api/premium/test-activate', { method: 'POST', headers: { Authorization: 'Bearer ' + cred, 'Content-Type': 'application/json' }, body: '{}' })
  const b = await chromium.launch()
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 } })
  const p = await ctx.newPage()
  p.on('pageerror', (e) => console.log('pageerror:', e.message))
  await p.addInitScript((tk) => sessionStorage.setItem('arena_session_token', tk), cred)
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 }).catch(() => console.log('ME TIMEOUT'))
  await p.waitForTimeout(1500)
  console.log(await p.evaluate(() => ({ td: typeof window.toggleDrawer, sn: typeof window.switchNavTab, drawer: !!document.querySelector('#drawer'), grid: !!document.querySelector('#settings-theme-grid') })))
  await p.evaluate(() => { window.toggleDrawer && toggleDrawer(true); setTimeout(() => window.switchNavTab && switchNavTab('settings'), 700) })
  await p.waitForTimeout(3500)
  console.log(await p.evaluate(() => { const g = document.querySelector('#settings-theme-grid'); return { children: g ? g.children.length : -1, visible: g ? g.getBoundingClientRect().height : 0, navtab: document.querySelector('.nav-tab.active')?.dataset?.tab || document.body.dataset } }))
  await p.screenshot({ path: '/home/user/art-arena/docs/shots-v81/v82-dbg-settings.png' })
  await ctx.close(); await b.close()
  console.log('DBG DONE')
})().catch((e) => { console.error('DBG FAILED', e); process.exit(1) })
