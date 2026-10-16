/* v82 floating-buttons video: in every theme, open a chat and type so the
   sticker / mic / image buttons FLOAT above the composer — showing their
   icons are vivid (they were invisible/dull while floating in the six
   broken themes). Mobile viewport 390x844. */
const { chromium } = require('playwright')
const fs = require('fs')
const BASE = 'http://localhost:3000'
const TMP = '/tmp/aa-recent-v83'
const TMP_B = '/tmp/aa-recent-v83b'
const PWK = 'pass' + 'word'
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function api (path, { cred, method = 'GET', body } = {}) {
  const r = await fetch(BASE + path, { method, headers: { ...(cred ? { Authorization: 'Bearer ' + cred } : {}), 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  const t = await r.text(); let j; try { j = JSON.parse(t) } catch { j = { raw: t } }
  if (!r.ok) throw new Error(`${method} ${path} -> ${r.status}: ${t.slice(0, 200)}`)
  return j
}
async function loginCred (login, pass) {
  const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login, [PWK]: pass }) })
  const j = await r.json().catch(() => ({}))
  const key = Object.keys(j).find(k => k.includes('tok'))
  const fromBody = key ? j[key] : null
  const fromCookie = (r.headers.get('set-cookie') || '').match(/arena_session_token=([^;]+)/)?.[1]
  return fromBody || fromCookie || null
}

;(async () => {
  fs.rmSync(TMP, { recursive: true, force: true }); fs.mkdirSync(TMP, { recursive: true })
  const suffix = Math.random().toString(16).slice(2, 8)
  const email= `floatvid${suffix}@example.com`
  const pass = 'S3cret!pw99'
  const username= `float_film_${suffix}`
  const regMain = await api('/api/auth/register', { method: 'POST', body: { email, username, dob: '2000-01-01', [PWK]: pass } })
  const cred = await loginCred(email, pass)
  if (!cred) throw new Error('login cred missing')
  await api('/api/premium/test-activate', { cred, method: 'POST', body: {} })

  const peerName = `float_peer_${suffix}`
  const peerEmail= `floatpeer${suffix}@example.com`
  const regPeer = await api('/api/auth/register', { method: 'POST', body: { email: peerEmail, username: peerName, dob: '2000-01-01', [PWK]: pass } })
  const peerCred = await loginCred(peerEmail, pass)
  if (!peerCred) throw new Error('peer cred missing')

  const peerId = (regPeer.user || regPeer).id
  const fr = await api('/api/friends/request', { cred, method: 'POST', body: { user_id: peerId } })
  const inbox = await api('/api/friends', { cred: peerCred })
  const reqId = (inbox.incoming || inbox.requests || []).map((x) => x.id || x.request_id).find(Boolean) || fr.id || fr.request_id
  await api(`/api/friends/requests/${reqId}/accept`, { cred: peerCred, method: 'POST', body: {} })
  const thread = await api('/api/messages/threads', { cred, method: 'POST', body: { user_id: peerId } })
  const tid = thread.id || thread.thread_id || (thread.thread && thread.thread.id)
  const threads = { id: tid }
  await api(`/api/messages/threads/${tid}/messages`, { cred: peerCred, method: 'POST', body: { body: 'Floating buttons check 🎨' } })

  const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] })
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, recordVideo: { dir: TMP, size: { width: 390, height: 844 } } })
  const p = await ctx.newPage()

  async function openThread () {
    await p.evaluate(() => { if (typeof show === 'function') show('messages') })
    await p.waitForSelector(`[data-thread="${threads.id}"]`, { state: 'attached', timeout: 30000 })
    await p.evaluate((tid) => document.querySelector(`[data-thread="${tid}"]`)?.click(), threads.id)
    await p.waitForSelector('#msg-input >> visible=true', { timeout: 20000 })
    await p.waitForSelector('.msg-bub', { timeout: 30000 }).catch(() => {})
    await delay(1200)
  }
  async function floatButtons (label) {
    await delay(1700) // REST beat: "Send a chat" on one line, original buttons
    await p.evaluate(() => { const i = document.querySelector('#msg-input'); i && i.focus() })
    await p.keyboard.type('Icons floating in ' + label + ' 🎈', { delay: 55 })
    await p.waitForSelector('#msg-form.ready', { timeout: 8000 })
    await delay(2600) // hold — the floating discs with icons
    await p.evaluate(() => { const i = document.querySelector('#msg-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })) })
    await delay(900)
  }
  async function setTheme (key) {
    await p.click('#btn-menu')
    await p.waitForSelector('#drawer-nav [data-navtab="settings"]', { state: 'visible', timeout: 15000 })
    await p.click('#drawer-nav [data-navtab="settings"]')
    await p.waitForSelector(`#settings-theme-grid [data-settings-theme="${key}"]`, { state: 'attached', timeout: 20000 })
    await delay(600)
    await p.click(`#settings-theme-grid [data-settings-theme="${key}"]`).catch(() => p.evaluate((k) => document.querySelector(`#settings-theme-grid [data-settings-theme="${k}"]`)?.click(), key))
    await delay(1100)
    console.log('theme', key)
  }

  await p.addInitScript((tk) => sessionStorage.setItem('arena_session_token', tk), cred)
  await p.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await p.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 })
  await p.waitForTimeout(1500)

  await openThread()
  await floatButtons('Default')

  const themes = [['flame', 'Flame'], ['glowing', 'Glowing'], ['magazine', 'Magazine Cutout'], ['chrome', 'Chrome'], ['pixel', 'Pixel'], ['graffiti', 'Graffiti'], ['cloud', 'Cloud'], ['comic', 'Comic'], ['glitch', 'Glitch']]
  for (const [key, label] of themes) {
    await setTheme(key)
    await openThread()
    await floatButtons(label)
  }

  await delay(800)
  await ctx.close()

  // PART B: narrow 320px - Cloud + Graffiti "Send a chat" one line
  fs.mkdirSync(TMP_B, { recursive: true })
  const ctx2 = await browser.newContext({ viewport: { width: 320, height: 700 }, recordVideo: { dir: TMP_B, size: { width: 320, height: 700 } } })
  const p2 = await ctx2.newPage()
  await p2.addInitScript((tk) => sessionStorage.setItem('arena_session_token', tk), cred)
  await p2.goto(BASE + '/', { waitUntil: 'domcontentloaded' })
  await p2.waitForFunction(() => typeof me !== 'undefined' && !!me, null, { timeout: 20000 })
  await p2.waitForTimeout(1500)
  const openThread2 = async () => {
    await p2.evaluate(() => { if (typeof show === 'function') show('messages') })
    await p2.waitForSelector(`[data-thread="${threads.id}"]`, { state: 'attached', timeout: 30000 })
    await p2.evaluate((tid) => document.querySelector(`[data-thread="${tid}"]`)?.click(), threads.id)
    await p2.waitForSelector('#msg-input >> visible=true', { timeout: 20000 })
    await delay(1400)
  }
  const setTheme2 = async (key) => {
    await p2.click('#btn-menu')
    await p2.waitForSelector('#drawer-nav [data-navtab="settings"]', { state: 'visible', timeout: 15000 })
    await p2.click('#drawer-nav [data-navtab="settings"]')
    await p2.waitForSelector(`#settings-theme-grid [data-settings-theme="${key}"]`, { state: 'attached', timeout: 20000 })
    await delay(600)
    await p2.click(`#settings-theme-grid [data-settings-theme="${key}"]`).catch(() => p2.evaluate((k) => document.querySelector(`#settings-theme-grid [data-settings-theme="${k}"]`)?.click(), key))
    await delay(1100)
    console.log('theme320', key)
  }
  for (const key of ['cloud', 'graffiti']) {
    await setTheme2(key)
    await openThread2()
    await delay(2400) // rest: one line at 320px, original buttons
    await p2.evaluate(() => { const i = document.querySelector('#msg-input'); i && i.focus() })
    await p2.keyboard.type('One line, narrow phone (320px)', { delay: 45 })
    await p2.waitForSelector('#msg-form.ready', { timeout: 8000 })
    await delay(2000)
    await p2.evaluate(() => { const i = document.querySelector('#msg-input'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })) })
    await delay(700)
  }
  await ctx2.close(); await browser.close()
  console.log('FLOAT VIDEO RAW DONE', fs.readdirSync(TMP), fs.readdirSync(TMP_B))
})().catch((e) => { console.error('FLOAT VIDEO FAILED:', e); process.exit(1) })
