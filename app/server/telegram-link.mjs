import { randomBytes } from 'node:crypto'

const pendingFor = 5 * 60_000
const signedInFor = 12 * 60 * 60_000
const maxLinks = 2000

export function createTelegramLink(telegram) {
  const links = new Map()
  const byCode = new Map()

  function remove(browser, link) {
    links.delete(browser)
    if (link.code) byCode.delete(link.code)
  }

  function get(browser) {
    const link = links.get(browser)
    if (!link || link.expiresAt > Date.now()) return link
    remove(browser, link)
  }

  return {
    start(browser) {
      const existing = get(browser)
      if (existing?.actor) return { browser, url: null, actor: existing.actor }
      const code = existing?.code ?? randomBytes(24).toString('base64url')
      const url = telegram?.loginUrl?.(code)
      if (!url) return null
      if (existing) return { browser, url, actor: null }
      for (const [key] of links) get(key)
      if (links.size >= maxLinks) return null
      browser = randomBytes(32).toString('base64url')
      links.set(browser, { code, expiresAt: Date.now() + pendingFor })
      byCode.set(code, browser)
      return { browser, url, actor: null }
    },
    actor(browser) {
      return get(browser)?.actor ?? null
    },
    confirm(code, actor) {
      const browser = byCode.get(code)
      const link = get(browser)
      if (!link || link.code !== code || !actor.userId || !actor.username) return false
      byCode.delete(code)
      links.set(browser, { actor, expiresAt: Date.now() + signedInFor })
      return true
    },
    logout(browser) {
      const link = get(browser)
      if (link) remove(browser, link)
    },
  }
}
