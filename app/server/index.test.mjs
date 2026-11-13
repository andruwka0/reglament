import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { Agent, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Duplex, PassThrough } from 'node:stream'
import { test } from 'node:test'
import { createTrackerServer } from './index.mjs'

const password = 'organizer-password-for-test'
const task = (id, assignee = '') => ({
  id, title: `Задача ${id}`, description: '', start: '15:30', end: '16:00', assignee, status: 'todo',
})

async function fixture(t, options) {
  const dataDir = await mkdtemp(join(tmpdir(), 'regatta-tracker-'))
  let server
  let agent
  let cookie

  function stop() {
    agent.destroy()
    server.emit('close')
  }

  t.after(async () => {
    if (server) stop()
    await rm(dataDir, { recursive: true, force: true })
  })

  function start(options) {
    server = createTrackerServer({ password, dataDir, ...options })
    agent = new Agent({ keepAlive: false })
    // Run the real HTTP parser against paired streams so the tests need no listening port.
    agent.createConnection = () => {
      const requestStream = new PassThrough()
      const responseStream = new PassThrough()
      const client = Duplex.from({ readable: responseStream, writable: requestStream })
      const connection = Duplex.from({ readable: requestStream, writable: responseStream })
      connection.setTimeout = () => connection
      connection.destroySoon = () => connection.end()
      client.once('close', () => connection.destroy())
      server.emit('connection', connection)
      return client
    }
    cookie = undefined
  }

  function raw(path, { method = 'GET', body, admin, token, authorization, fetchSite, contentType, bytes = false } = {}) {
    const headers = {}
    if (body !== undefined) headers['Content-Type'] = contentType ?? 'application/json'
    if (admin && cookie) headers.Cookie = cookie
    if (authorization !== undefined) headers.Authorization = authorization
    else if (token) headers.Authorization = `Bearer ${token}`
    if (fetchSite) headers['Sec-Fetch-Site'] = fetchSite
    return new Promise((resolve, reject) => {
      const request = httpRequest(`http://regatta.test${path}`, { agent, method, headers }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const buffer = Buffer.concat(chunks)
          resolve({ status: response.statusCode, text: buffer.toString('utf8'), bytes: bytes ? buffer : undefined, headers: response.headers })
        })
        response.on('error', reject)
      })
      request.on('error', reject)
      request.end(body === undefined || Buffer.isBuffer(body) ? body : JSON.stringify(body))
    })
  }

  async function request(path, options) {
    const { status, text, headers } = await raw('/api' + path, options)
    if (path === '/admin/login' && status === 200) cookie = headers['set-cookie'][0].split(';')[0]
    return { status, data: JSON.parse(text), headers }
  }

  function stream(path) {
    return new Promise((resolve, reject) => {
      const request = httpRequest(`http://regatta.test/api${path}`, { agent }, (response) => {
        if (response.statusCode !== 200) {
          response.resume()
          reject(new Error(`Expected stream to return HTTP 200, got ${response.statusCode}`))
          return
        }
        response.setEncoding('utf8')
        const queue = []
        let buffer = ''
        let pending
        response.on('data', (chunk) => {
          buffer += chunk
          let boundary
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const data = buffer.slice(0, boundary).split('\n').find((line) => line.startsWith('data: '))
            buffer = buffer.slice(boundary + 2)
            if (!data) continue
            const snapshot = JSON.parse(data.slice(6))
            if (pending) {
              pending(snapshot)
              pending = undefined
            } else queue.push(snapshot)
          }
        })
        response.on('error', () => {})
        resolve({
          headers: response.headers,
          next: () => queue.length ? Promise.resolve(queue.shift()) : new Promise((receive) => { pending = receive }),
          close: () => request.destroy(),
        })
      })
      request.on('error', reject)
      request.end()
    })
  }

  async function login() {
    const result = await request('/admin/login', { method: 'POST', body: { password } })
    assert.equal(result.status, 200)
    assert.match(result.headers['set-cookie'][0], /HttpOnly.*SameSite=Strict/)
  }

  start(options)
  return {
    request, raw, stream, login, dataDir,
    restart(options) {
      stop()
      start(options)
    },
  }
}

async function createEvent(app) {
  await app.login()
  const created = await app.request('/admin/events', {
    method: 'POST', admin: true, body: { title: 'Регата', date: '2026-11-13' },
  })
  assert.equal(created.status, 201)
  const draft = created.data
  draft.roles = [{
    id: 'role-a', title: 'Регистрация', description: 'Первый этаж', assignee: '@Organizer',
    tasks: [task('role-default'), task('task-override', '@Volunteer')],
  }]
  draft.info = [{ id: 'info-a', label: 'Чат', value: 'https://example.org' }]
  draft.timeline = [{ id: 'start', title: 'Начало', start: '15:30', end: '', description: '' }]
  draft.tasks = [task('shared', '@volunteer'), task('unassigned')]
  const saved = await app.request(`/admin/events/${draft.id}`, { method: 'PUT', admin: true, body: draft })
  assert.equal(saved.status, 200)
  return saved.data
}

const tinyPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aRZkAAAAASUVORK5CYII=', 'base64')

test('an organizer can sign in with a configured four-digit PIN', async (t) => {
  const pin = '0637'
  const app = await fixture(t, { password: pin })
  const wrong = await app.request('/admin/login', { method: 'POST', body: { password: '637' } })
  assert.equal(wrong.status, 401)
  const result = await app.request('/admin/login', { method: 'POST', body: { password: pin } })
  assert.equal(result.status, 200)
  assert.match(result.headers['set-cookie'][0], /HttpOnly.*SameSite=Strict/)
  assert.deepEqual((await app.request('/admin/session', { admin: true })).data, { authenticated: true })
})

test('short credentials other than four-digit PINs are rejected', () => {
  for (const password of ['abc1', '063', '06371', '0637\n']) {
    assert.throws(() => createTrackerServer({ password }), /ADMIN_PASSWORD/)
  }
})

test('event streams push successful changes, preserve cover versions and reconnect with the latest snapshot', { timeout: 3500 }, async (t) => {
  const app = await fixture(t)
  const event = await createEvent(app)
  const path = `/events/${event.id}`
  assert.equal((await app.request('/events/missing/stream')).status, 404)
  const subscription = await app.stream(`${path}/stream`)
  t.after(() => subscription.close())
  assert.match(subscription.headers['content-type'], /^text\/event-stream/)
  assert.equal(subscription.headers['x-accel-buffering'], 'no')
  assert.match(subscription.headers['cache-control'], /no-transform/)
  assert.deepEqual(await subscription.next(), event)

  const statusPath = `${path}/tasks/shared/status`
  const denied = await app.request(statusPath, { method: 'POST', body: { status: 'blocked' } })
  assert.equal(denied.status, 403)
  const changed = await app.request(statusPath, {
    method: 'POST', body: { status: 'blocked', assignee: '@volunteer' },
  })
  assert.equal(changed.status, 200)
  assert.equal(changed.data.tasks[0].status, 'blocked')
  assert.deepEqual(await subscription.next(), changed.data)

  const cover = await app.request(`/admin${path}/cover`, {
    method: 'PUT', admin: true, body: tinyPng, contentType: 'image/png',
  })
  assert.equal(cover.status, 200)
  assert.equal(cover.data.revision, changed.data.revision)
  assert.deepEqual(await subscription.next(), cover.data)
  const edited = await app.request(`/admin${path}`, {
    method: 'PUT', admin: true, body: { ...cover.data, title: 'Новое название' },
  })
  assert.equal(edited.status, 200)
  assert.deepEqual(await subscription.next(), edited.data)
  subscription.close()

  const removed = await app.request(`/admin${path}/cover`, { method: 'DELETE', admin: true })
  assert.equal(removed.status, 200)
  const resumed = await app.stream(`${path}/stream`)
  t.after(() => resumed.close())
  assert.deepEqual(await resumed.next(), removed.data)
})

test('streams a complete snapshot larger than the socket high-water mark', { timeout: 3500 }, async (t) => {
  const app = await fixture(t)
  const event = await createEvent(app)
  event.info = Array.from({ length: 30 }, (_, index) => ({
    id: `info-${index}`, label: `Памятка ${index}`, value: 'Длинная памятка. '.repeat(200),
  }))
  const path = `/events/${event.id}`
  const saved = await app.request(`/admin${path}`, { method: 'PUT', admin: true, body: event })
  assert.equal(saved.status, 200)
  const stream = await app.stream(`${path}/stream`)
  t.after(() => stream.close())
  assert.deepEqual(await stream.next(), saved.data)
})

test('migrates existing events and persists a public cover independently of draft revisions', async (t) => {
  const app = await fixture(t)
  const event = await createEvent(app)
  const db = new DatabaseSync(join(app.dataDir, 'regatta.sqlite'))
  try {
    db.exec('DROP TABLE IF EXISTS covers; PRAGMA user_version = 1;')
  } finally {
    db.close()
  }
  app.restart()
  const path = `/events/${event.id}`
  const cover = `${path}/cover`
  const adminCover = `/admin${cover}`
  const upload = { method: 'PUT', body: tinyPng, contentType: 'image/png' }
  assert.deepEqual((await app.request(path)).data, event)
  assert.equal((await app.request(cover)).status, 404)
  assert.equal((await app.request(adminCover, upload)).status, 401)
  assert.equal((await app.request(adminCover, { method: 'DELETE' })).status, 401)
  await app.login()
  const saved = await app.request(adminCover, { ...upload, admin: true })
  assert.equal(saved.status, 200)
  assert.equal(typeof saved.data.coverVersion, 'string')
  assert.equal(saved.data.revision, event.revision)
  const image = await app.raw(`/api${cover}`, { bytes: true })
  assert.equal(image.status, 200)
  assert.equal(image.headers['content-type'], 'image/png')
  assert.equal(image.headers['cache-control'], 'no-store')
  assert.deepEqual(image.bytes, tinyPng)
  assert.equal((await app.request('/admin/catalog', { admin: true })).data.events[0].coverVersion, saved.data.coverVersion)

  const changed = await app.request(`/admin${path}`, {
    method: 'PUT', admin: true, body: { ...event, title: 'Другое название', coverVersion: 'arbitrary' },
  })
  assert.equal(changed.status, 200)
  assert.equal(changed.data.coverVersion, saved.data.coverVersion)
  const statusChanged = await app.request(`${path}/tasks/shared/status`, {
    method: 'POST', body: { status: 'done', assignee: '@volunteer' },
  })
  assert.equal(statusChanged.data.coverVersion, saved.data.coverVersion)
  const template = await app.request('/admin/templates', {
    method: 'POST', admin: true, body: { eventId: event.id, title: 'Шаблон регаты' },
  })
  assert.equal(template.data.event.coverVersion, undefined)
  const imported = await app.request('/admin/events/import', {
    method: 'POST', admin: true, body: { title: 'Импорт с обложкой', coverVersion: saved.data.coverVersion },
  })
  assert.equal(imported.status, 400)

  app.restart()
  assert.equal((await app.request(path)).data.coverVersion, saved.data.coverVersion)
  assert.deepEqual((await app.raw(`/api${cover}`, { bytes: true })).bytes, tinyPng)
  await app.login()
  const removed = await app.request(adminCover, { method: 'DELETE', admin: true })
  assert.equal(removed.status, 200)
  assert.equal(removed.data.coverVersion, undefined)
  assert.equal(removed.data.revision, statusChanged.data.revision)
  assert.equal((await app.request(cover)).status, 404)
})

test('rejects oversized covers, unsupported formats and mismatched image signatures', async (t) => {
  const app = await fixture(t)
  const event = await createEvent(app)
  const path = `/admin/events/${event.id}/cover`
  const upload = (contentType, body) => app.request(path, { method: 'PUT', admin: true, contentType, body })
  assert.equal((await upload('image/svg+xml', Buffer.from('<svg />'))).status, 415)
  assert.equal((await upload('image/jpeg', tinyPng)).status, 400)
  assert.equal((await upload('image/webp', Buffer.from('RIFF'))).status, 400)
  const invalidWebp = Buffer.from('RIFF0000WEBPVP8 0000')
  invalidWebp[0] |= 0x80
  assert.equal((await upload('image/webp', invalidWebp)).status, 400)
  assert.equal((await upload('image/png', Buffer.concat([tinyPng, Buffer.alloc(1024 * 1024)]))).status, 413)
  assert.equal((await app.request(`/events/${event.id}/cover`)).status, 404)
})

test('a shared event link lets a selected participant change only their own assigned tasks', async (t) => {
  const app = await fixture(t)
  const event = await createEvent(app)
  const path = `/events/${event.id}`
  assert.deepEqual((await app.request(path)).data, event)
  assert.equal((await app.request('/admin/catalog')).status, 401)
  assert.equal((await app.request(`/admin${path}/invites`)).status, 401)
  assert.equal((await app.request(`/admin${path}`, { method: 'PUT', body: event })).status, 401)
  const mark = (id, status, assignee, options = {}) => app.request(`${path}/tasks/${id}/status`, {
    method: 'POST', body: { status, assignee, title: 'Другое название' }, fetchSite: 'same-origin', ...options,
  })
  assert.equal((await mark('role-default', 'doing', '@organizer', { fetchSite: 'cross-site' })).status, 403)
  assert.equal((await mark('role-default', 'doing', '@organizer', { fetchSite: 'same-site' })).status, 403)
  assert.equal((await mark('role-default', 'unknown', '@organizer')).status, 400)
  assert.equal((await mark('role-default', 'doing')).status, 403)
  assert.equal((await mark('role-default', 'doing', '')).status, 403)
  assert.equal((await mark('role-default', 'doing', 'invalid handle')).status, 400)
  assert.equal((await mark('role-default', 'doing', '@volunteer')).status, 403)
  assert.equal((await mark('task-override', 'doing', '@organizer')).status, 403)
  assert.equal((await mark('unassigned', 'done', '@volunteer')).status, 403)
  assert.equal((await mark('task-override', 'doing', '@organizer', { admin: true })).status, 403)
  assert.equal((await mark('unassigned', 'done', '', { admin: true })).status, 403)
  assert.equal((await mark('role-default', 'doing', '@organizer', { token: 'invalid' })).status, 401)
  assert.equal((await mark('role-default', 'doing', '@organizer', { authorization: 'Bearer' })).status, 401)
  assert.deepEqual((await app.request(path)).data, event)
  assert.equal((await mark('role-default', 'doing', ' Organizer ')).data.roles[0].tasks[0].status, 'doing')
  assert.equal((await mark('shared', 'blocked', '@volunteer')).data.tasks[0].status, 'blocked')
  assert.equal((await mark('task-override', 'doing', '@volunteer')).data.roles[0].tasks[1].status, 'doing')
  const { data: updated } = await mark('unassigned', 'done', undefined, { admin: true })
  assert.equal(updated.tasks[1].status, 'done')
  assert.equal(updated.tasks[1].title, event.tasks[1].title)
  assert.equal(updated.revision, event.revision + 4)
  assert.equal((await app.request(`/admin${path}`, { method: 'PUT', body: event, admin: true })).status, 409)
  app.restart()
  assert.deepEqual((await app.request(path)).data, updated)
})

test('existing personal links still work and cannot be used for a different assignment', async (t) => {
  const app = await fixture(t)
  const event = await createEvent(app)
  const path = `/events/${event.id}`
  assert.equal((await app.request('/admin/catalog')).status, 401)
  assert.equal((await app.request(`/admin${path}/invites`)).status, 401)
  assert.deepEqual((await app.request(path)).data, event)
  const invites = (await app.request(`/admin${path}/invites`, { admin: true })).data
  assert.deepEqual(invites.map(({ assignee }) => assignee), ['@organizer', '@volunteer'])
  const [organizer, volunteer] = invites
  assert.equal((await app.request(`${path}/access`, { token: volunteer.token })).data.assignee, '@volunteer')
  const mark = (id, token, status = 'doing', assignee) => app.request(`${path}/tasks/${id}/status`, {
    method: 'POST', body: { status, assignee }, token,
  })
  assert.equal((await mark('shared', organizer.token, 'doing', '@volunteer')).status, 403)
  assert.equal((await mark('task-override', organizer.token)).status, 403)
  assert.equal((await mark('role-default', volunteer.token)).status, 403)
  assert.equal((await mark('task-override', volunteer.token)).data.roles[0].tasks[1].status, 'doing')
  assert.equal((await mark('role-default', organizer.token)).data.roles[0].tasks[0].status, 'doing')
  const updated = (await mark('shared', volunteer.token, 'done')).data
  assert.equal(updated.tasks[0].status, 'done')
  assert.equal(updated.revision, event.revision + 3)
  const stale = await app.request(`/admin${path}`, { method: 'PUT', body: event, admin: true })
  assert.equal(stale.status, 409)
  assert.deepEqual((await app.request(path)).data, updated)

  app.restart()
  assert.deepEqual((await app.request(path)).data, updated)
  assert.equal((await app.request(`${path}/access`, { token: volunteer.token })).data.assignee, '@volunteer')
  await app.login()
  updated.roles[0].tasks[1].assignees = []
  updated.tasks[0].assignees = []
  assert.equal((await app.request(`/admin${path}`, { method: 'PUT', body: updated, admin: true })).status, 200)
  assert.equal((await app.request(`${path}/access`, { token: volunteer.token })).status, 401)
})

test('stores deduped assignment lists and inherits all role assignees in scoped requests', async (t) => {
  const app = await fixture(t)
  const draft = await createEvent(app)
  const path = `/events/${draft.id}`
  assert.deepEqual(draft.roles[0].assignees, ['@organizer'])
  assert.deepEqual(draft.tasks[0].assignees, ['@volunteer'])
  draft.roles[0].assignees = [' @Organizer ', 'Helper', '@HELPER']
  draft.roles[0].tasks[1].assignees = ['Volunteer', '@extra']
  draft.tasks[0].assignees = []
  const saved = await app.request(`/admin${path}`, { method: 'PUT', body: draft, admin: true })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.data.roles[0].assignees, ['@organizer', '@helper'])
  assert.deepEqual(saved.data.roles[0].tasks[1].assignees, ['@volunteer', '@extra'])
  assert.deepEqual(saved.data.tasks[0].assignees, [])
  assert.equal(saved.data.tasks[0].assignee, '')
  assert.equal(saved.data.roles[0].assignee, '@organizer')
  const invites = (await app.request(`/admin${path}/invites`, { admin: true })).data
  assert.deepEqual(invites.map(({ assignee }) => assignee), ['@extra', '@helper', '@organizer', '@volunteer'])
  const [extra, helper] = invites
  const mark = (id, token, assignee) => app.request(`${path}/tasks/${id}/status`, {
    method: 'POST', body: { status: 'done', assignee }, token,
  })
  assert.equal((await mark('role-default', helper.token)).status, 200)
  assert.equal((await mark('task-override', helper.token)).status, 403)
  assert.equal((await mark('task-override', extra.token)).status, 200)
  assert.equal((await mark('shared', extra.token)).status, 403)
  assert.equal((await mark('shared', undefined, '@extra')).status, 403)
  assert.equal((await mark('role-default', undefined, '@helper')).status, 200)
  assert.equal((await mark('task-override', undefined, '@helper')).status, 403)
  assert.equal((await mark('task-override', undefined, '@extra')).status, 200)
  app.restart()
  const reloaded = (await app.request(path)).data
  assert.deepEqual(reloaded.roles[0].assignees, ['@organizer', '@helper'])
  assert.deepEqual(reloaded.roles[0].tasks[1].assignees, ['@volunteer', '@extra'])
})

test('reads legacy SQLite assignments and saves edits from clients sending only assignee', async (t) => {
  const app = await fixture(t)
  const event = await createEvent(app)
  const path = `/events/${event.id}`
  const legacyItems = [...event.roles, ...event.roles.flatMap((role) => role.tasks), ...event.tasks]
  for (const item of legacyItems) delete item.assignees
  const db = new DatabaseSync(join(app.dataDir, 'regatta.sqlite'))
  try {
    db.prepare('UPDATE events SET data = ? WHERE id = ?').run(JSON.stringify(event), event.id)
  } finally {
    db.close()
  }
  assert.deepEqual((await app.request(path)).data.roles[0].assignees, ['@organizer'])
  event.roles[0].assignee = '@replacement'
  const saved = await app.request(`/admin${path}`, { method: 'PUT', body: event, admin: true })
  assert.equal(saved.status, 200)
  assert.deepEqual(saved.data.roles[0].assignees, ['@replacement'])
  assert.equal(saved.data.roles[0].assignee, '@replacement')
})

test('templates make independent events and retain descriptions, timings, links but clear people and statuses', async (t) => {
  const app = await fixture(t)
  const event = await createEvent(app)
  event.roles[0].assignees = ['@organizer', '@helper']
  event.roles[0].tasks[1].assignees = ['@volunteer', '@extra']
  event.tasks[0].assignees = ['@volunteer', '@helper']
  event.roles[0].tasks[0].status = 'done'
  event.tasks[0].status = 'blocked'
  const saved = await app.request(`/admin/events/${event.id}`, { method: 'PUT', admin: true, body: event })
  assert.equal(saved.status, 200)
  const template = await app.request('/admin/templates', {
    method: 'POST', body: { eventId: event.id, title: 'Регата в школе' }, admin: true,
  })
  assert.equal(template.status, 201)
  app.restart()
  await app.login()
  assert.deepEqual((await app.request('/admin/catalog', { admin: true })).data.templates, [template.data])
  const clone = (await app.request('/admin/events', {
    method: 'POST', body: { title: 'Регата в апреле', date: '2027-04-10', templateId: template.data.id }, admin: true,
  })).data
  assert.equal(template.data.event.date, '')
  assert.equal(clone.title, 'Регата в апреле')
  assert.equal(clone.date, '2027-04-10')
  assert.notEqual(clone.id, event.id)
  assert.deepEqual(clone.info, event.info)
  assert.deepEqual(clone.timeline, event.timeline)
  assert.equal(clone.roles[0].description, 'Первый этаж')
  assert.equal(clone.roles[0].assignee, '')
  assert.deepEqual(clone.roles[0].assignees, [])
  assert.equal(clone.roles[0].tasks[0].status, 'todo')
  assert.equal(clone.roles[0].tasks[1].assignee, '')
  assert.deepEqual(clone.roles[0].tasks[1].assignees, [])
  assert.equal(clone.tasks[0].status, 'todo')
  assert.equal(clone.tasks[0].assignee, '')
  assert.deepEqual(clone.tasks[0].assignees, [])
  assert.equal((await app.request(`/events/${event.id}`)).data.tasks[0].status, 'blocked')
})

test('rejects ambiguous IDs and invalid dates without persisting either change', async (t) => {
  const app = await fixture(t)
  const event = await createEvent(app)
  const path = `/admin/events/${event.id}`
  const invalidDate = { ...event, date: '2026-02-30' }
  assert.equal((await app.request(path, { method: 'PUT', body: invalidDate, admin: true })).status, 400)
  const duplicate = { ...event, tasks: [task('role-default')] }
  assert.equal((await app.request(path, { method: 'PUT', body: duplicate, admin: true })).status, 400)
  assert.deepEqual((await app.request(`/events/${event.id}`)).data, event)
})

test('serves Angular routes and static files without falling back for missing assets', async (t) => {
  const app = await fixture(t)
  const staticDir = join(app.dataDir, 'browser')
  await mkdir(staticDir)
  await writeFile(join(staticDir, 'index.html'), '<main>Регата</main>')
  await writeFile(join(staticDir, 'main.js'), 'console.log(1)')
  app.restart({ staticDir })
  assert.equal((await app.raw('/event/example')).text, '<main>Регата</main>')
  assert.match((await app.raw('/main.js')).headers['content-type'], /javascript/)
  assert.equal((await app.raw('/missing.js')).status, 404)
  assert.equal((await app.raw('/api/unknown')).status, 404)
})

test('imports a full event with fresh IDs, preserves fields and creates personal access', async (t) => {
  const app = await fixture(t)
  const original = await createEvent(app)
  const path = '/admin/events/import'
  const input = {
    id: original.id, revision: original.revision, title: 'Импортированная регата', date: '2027-01-30',
    location: 'Главный корпус', description: 'Ориентиры и правила',
    info: [{ id: 'shared-id', label: 'Чат', value: 'https://example.org/regatta' }],
    timeline: [{ id: 'shared-id', title: 'Сбор', start: '10:00', end: '10:30', description: 'У входа' }],
    roles: [{
      id: 'shared-id', title: 'Навигация', description: 'Второй этаж', assignee: '@Guide',
      tasks: [{ id: 'shared-id', title: 'Подготовить указатели', start: '10:30', status: 'doing' }],
    }],
    tasks: [{ id: 'shared-id', title: 'Проверить зал', assignee: 'Legacy', assignees: ['Inspector', '@Helper', '@INSPECTOR'] }],
  }
  assert.equal((await app.request(path, { method: 'POST', body: input })).status, 401)
  const created = await app.request(path, { method: 'POST', body: input, admin: true })
  assert.equal(created.status, 201)
  const event = created.data
  assert.notEqual(event.id, original.id)
  assert.equal(event.revision, 0)
  assert.equal(event.title, input.title)
  assert.equal(event.date, input.date)
  assert.equal(event.location, input.location)
  assert.equal(event.description, input.description)
  const ids = [event.info[0].id, event.timeline[0].id, event.roles[0].id, event.roles[0].tasks[0].id, event.tasks[0].id]
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(ids.every((id) => id !== 'shared-id'))
  assert.equal(event.info[0].value, input.info[0].value)
  assert.equal(event.timeline[0].end, '10:30')
  assert.equal(event.roles[0].description, 'Второй этаж')
  assert.equal(event.roles[0].assignee, '@guide')
  assert.deepEqual(event.roles[0].assignees, ['@guide'])
  assert.deepEqual(event.roles[0].tasks[0], {
    id: event.roles[0].tasks[0].id, title: 'Подготовить указатели', start: '10:30',
    end: '', description: '', assignee: '', assignees: [], status: 'doing',
  })
  assert.equal(event.tasks[0].assignee, '@inspector')
  assert.deepEqual(event.tasks[0].assignees, ['@inspector', '@helper'])
  assert.equal(event.tasks[0].status, 'todo')
  assert.deepEqual((await app.request(`/events/${original.id}`)).data, original)
  app.restart()
  assert.deepEqual((await app.request(`/events/${event.id}`)).data, event)
  await app.login()
  const invites = (await app.request(`/admin/events/${event.id}/invites`, { admin: true })).data
  assert.deepEqual(invites.map(({ assignee }) => assignee), ['@guide', '@helper', '@inspector'])
  const changed = await app.request(`/events/${event.id}/tasks/${event.roles[0].tasks[0].id}/status`, {
    method: 'POST', token: invites[0].token, body: { status: 'done' },
  })
  assert.equal(changed.data.roles[0].tasks[0].status, 'done')
})

test('defaults omitted import fields and rejects malformed or misspelled fields atomically', async (t) => {
  const app = await fixture(t)
  await app.login()
  const upload = (body) => app.request('/admin/events/import', { method: 'POST', admin: true, body })
  const created = await upload({ title: 'Минимальное мероприятие' })
  assert.equal(created.status, 201)
  assert.deepEqual(created.data, {
    id: created.data.id, revision: 0, title: 'Минимальное мероприятие', date: '', location: '',
    description: '', info: [], timeline: [], roles: [], tasks: [],
  })
  const failures = [
    [{ title: '  ' }, /Название/],
    [{ title: 'Регата', tasks: null }, /tasks/],
    [{ title: 'Регата', roles: [null] }, /roles\[1\]/],
    [{ title: 'Регата', roles: [{ title: 'Роль', tasks: [{ title: 'Задача', strt: '15:00' }] }] }, /roles\[1\]\.tasks\[1\].*strt/],
    [{ title: 'Регата', tasks: [{ title: 'Задача', start: '25:00' }] }, /Время|ЧЧ:ММ/],
    [{ title: 'Регата', roles: [{ title: 'Роль', assignee: '@Guide' }], tasks: [{ title: 'Задача', status: 'complete' }] }, /статус/],
    [{ title: 'Регата', roles: [{ title: 'Роль', assignees: '@Guide' }] }, /ответственн/],
    [{ title: 'Регата', tasks: [{ title: 'Задача', assignee: null }] }, /Telegram/],
    [{ title: 'Регата', tasks: [{ title: 'Задача', assignees: ['hello world'] }] }, /Telegram/],
  ]
  for (const [input, errorPattern] of failures) {
    const result = await upload(input)
    assert.equal(result.status, 400)
    assert.match(result.data.error, errorPattern)
  }
  assert.deepEqual((await app.request('/admin/catalog', { admin: true })).data.events, [created.data])
})

test('the example linked in the import dialog is accepted as written', async (t) => {
  const app = await fixture(t)
  await app.login()
  const example = await readFile(new URL('../public/event-import-example.json', import.meta.url), 'utf8')
  const body = JSON.parse(example)
  const result = await app.request('/admin/events/import', { method: 'POST', admin: true, body })
  assert.equal(result.status, 201)
  assert.equal(result.data.title, body.title)
  assert.deepEqual(result.data.roles[0].assignees, body.roles[0].assignees)
  assert.deepEqual(result.data.roles[0].tasks[1].assignees, body.roles[0].tasks[1].assignees)
})

test('imports and saves multiline event information without a title', async (t) => {
  const app = await fixture(t)
  await app.login()
  const text = 'Вход через двор.\n\nЗвоните координатору при задержке.'
  const imported = await app.request('/admin/events/import', {
    method: 'POST', admin: true, body: {
      title: 'Регата',
      info: [{ value: text }, { label: 'Рабочий чат', value: 'https://example.org/chat' }],
    },
  })
  assert.equal(imported.status, 201)
  assert.deepEqual(imported.data.info.map(({ label, value }) => ({ label, value })), [
    { label: '', value: text },
    { label: 'Рабочий чат', value: 'https://example.org/chat' },
  ])

  const event = imported.data
  const saved = await app.request(`/admin/events/${event.id}`, {
    method: 'PUT', admin: true,
    body: { ...event, info: [{ id: 'plain-text', label: '', value: text }] },
  })
  assert.equal(saved.status, 200)
  assert.deepEqual((await app.request(`/events/${event.id}`)).data.info, [
    { id: 'plain-text', label: '', value: text },
  ])

  const empty = await app.request('/admin/events/import', {
    method: 'POST', admin: true, body: { title: 'Пустой текст', info: [{ value: ' \n ' }] },
  })
  assert.equal(empty.status, 400)
  assert.match(empty.data.error, /Текст/)
})
