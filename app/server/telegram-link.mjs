import { createHash, randomBytes } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const pendingFor = 5 * 60_000
export const rememberForSeconds = 30 * 24 * 60 * 60
const maxPendingLinks = 2000
const browserPattern = /^[A-Za-z0-9_-]{43}$/
const codePattern = /^[A-Za-z0-9_-]{32}$/

const digest = (value) => createHash('sha256').update(value).digest('base64url')
const challenge = (browser) => createHash('sha256').update('telegram-browser-link:').update(browser)
  .digest().subarray(0, 24).toString('base64url')

export function createTelegramLink(telegram, { database }) {
  const db = new DatabaseSync(database, { timeout: 1000 })
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_browser_sessions (
      browser_hash TEXT PRIMARY KEY, code_hash TEXT UNIQUE,
      user_id TEXT, username TEXT, expires_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS telegram_browser_sessions_expiry ON telegram_browser_sessions (expires_at);
  `)
  const read = db.prepare('SELECT user_id, username FROM telegram_browser_sessions WHERE browser_hash = ? AND expires_at > ?')
  const prune = db.prepare('DELETE FROM telegram_browser_sessions WHERE expires_at <= ?')
  const create = db.prepare(`
    INSERT INTO telegram_browser_sessions (browser_hash, code_hash, expires_at)
    SELECT ?, ?, ? WHERE (SELECT COUNT(*) FROM telegram_browser_sessions WHERE code_hash IS NOT NULL) < ?
  `)
  const confirm = db.prepare(`
    UPDATE telegram_browser_sessions SET code_hash = NULL, user_id = ?, username = ?, expires_at = ?
    WHERE code_hash = ? AND expires_at > ?
  `)
  const remove = db.prepare('DELETE FROM telegram_browser_sessions WHERE browser_hash = ?')

  const get = (browser, now) => typeof browser === 'string' && browserPattern.test(browser)
    ? read.get(digest(browser), now) : undefined
  const linkedActor = (record) => record?.user_id ? { userId: record.user_id, username: record.username } : null

  return {
    start(browser) {
      const now = Date.now()
      const existing = get(browser, now)
      const actor = linkedActor(existing)
      if (actor) return { browser, url: null, actor }
      if (!existing) browser = randomBytes(32).toString('base64url')
      const code = challenge(browser)
      const url = telegram?.loginUrl?.(code)
      if (!url) return null
      if (!existing) {
        prune.run(now)
        if (!create.run(digest(browser), digest(code), now + pendingFor, maxPendingLinks).changes) return null
      }
      return { browser, url, actor: null }
    },
    actor(browser) {
      return linkedActor(get(browser, Date.now()))
    },
    confirm(code, actor) {
      if (typeof code !== 'string' || !codePattern.test(code) || !actor?.userId || !actor.username) return false
      const now = Date.now()
      return Boolean(confirm.run(String(actor.userId), actor.username, now + rememberForSeconds * 1000, digest(code), now).changes)
    },
    logout(browser) {
      if (typeof browser === 'string' && browserPattern.test(browser)) remove.run(digest(browser))
    },
    close: () => db.close(),
  }
}
