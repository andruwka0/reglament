import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { test } from 'node:test'
import { createTelegramLink, rememberForSeconds } from './telegram-link.mjs'

const telegram = { loginUrl: (code) => `https://t.me/fixture_bot?start=login_${code}` }
const actor = { userId: '101', username: '@participant' }
const codeOf = (start) => new URL(start.url).searchParams.get('start').slice('login_'.length)

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'reglament-telegram-link-'))
  const database = join(directory, 'regatta.sqlite')
  let auth = createTelegramLink(telegram, { database })
  t.after(async () => {
    auth.close()
    await rm(directory, { recursive: true, force: true })
  })
  return {
    get auth() { return auth },
    restart() {
      auth.close()
      auth = createTelegramLink(telegram, { database })
    },
    database,
  }
}

test('Telegram challenges and confirmed browser sessions survive reopening and cannot be confirmed twice', async (t) => {
  const app = await fixture(t)
  const first = app.auth.start()
  const second = app.auth.start()
  assert.match(first.browser, /^[A-Za-z0-9_-]{43}$/)
  assert.match(codeOf(first), /^[A-Za-z0-9_-]{32}$/)
  assert.notEqual(first.browser, second.browser)
  assert.equal(app.auth.actor(first.browser), null)
  app.restart()
  assert.deepEqual(app.auth.start(first.browser), first)
  const competitor = createTelegramLink(telegram, { database: app.database })
  try {
    assert.equal(app.auth.confirm(codeOf(first), actor), true)
    assert.equal(competitor.confirm(codeOf(first), { userId: '202', username: '@different' }), false)
    assert.equal(competitor.actor(second.browser), null)
  } finally {
    competitor.close()
  }
  app.restart()
  assert.deepEqual(app.auth.actor(first.browser), actor)
  assert.deepEqual(app.auth.start(first.browser), { browser: first.browser, url: null, actor })
  app.auth.logout(first.browser)
  app.restart()
  assert.equal(app.auth.actor(first.browser), null)
})

test('pending codes expire after five minutes and sessions expire thirty days after confirmation', async (t) => {
  let clock = Date.now()
  t.mock.method(Date, 'now', () => clock)
  const app = await fixture(t)
  const expired = app.auth.start()
  clock += 5 * 60_000
  assert.equal(app.auth.confirm(codeOf(expired), actor), false)
  const active = app.auth.start(expired.browser)
  assert.notEqual(active.browser, expired.browser)
  assert.equal(app.auth.confirm(codeOf(active), actor), true)
  const signedInFor = rememberForSeconds * 1000
  assert.equal(signedInFor, 30 * 24 * 60 * 60 * 1000)
  clock += signedInFor - 1
  assert.deepEqual(app.auth.actor(active.browser), actor)
  clock++
  app.restart()
  assert.equal(app.auth.actor(active.browser), null)
  assert.notEqual(app.auth.start(active.browser).browser, active.browser)
})

test('the challenge limit counts only pending requests and expired requests free capacity', async (t) => {
  let clock = Date.now()
  t.mock.method(Date, 'now', () => clock)
  const app = await fixture(t)
  const first = app.auth.start()
  const db = new DatabaseSync(app.database)
  try {
    db.prepare(`
      WITH RECURSIVE slots(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM slots WHERE n < 1999)
      INSERT INTO telegram_browser_sessions (browser_hash, code_hash, expires_at)
      SELECT 'browser-' || n, 'code-' || n, ? FROM slots
    `).run(clock + 5 * 60_000)
  } finally {
    db.close()
  }
  assert.equal(app.auth.start(), null)
  assert.equal(app.auth.confirm(codeOf(first), actor), true)
  assert.ok(app.auth.start())
  assert.equal(app.auth.start(), null)
  clock += 5 * 60_000
  assert.ok(app.auth.start())
  assert.deepEqual(app.auth.actor(first.browser), actor)
})
