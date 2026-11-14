import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { Agent, request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Duplex, PassThrough } from 'node:stream'
import { test } from 'node:test'
import { createTrackerServer } from './index.mjs'

test('Telegram browser login is one-time and workflow mutations require verified senior permissions', async (t) => {
  const demo = JSON.parse(await readFile(new URL('./demo.json', import.meta.url), 'utf8'))
  const role = demo.roles[0]
  const task = role.tasks[2]
  const seniorActor = { userId: '1001', username: role.assignee }
  const volunteerActor = { userId: '1002', username: role.tasks[2].assignee }
  const path = `/api/events/${demo.id}`
  const workflow = `${path}/workflow`
  const status = `${path}/tasks/${task.id}/status`
  const password = 'workflow-http-test-password'
  const dataDir = await mkdtemp(join(tmpdir(), 'reglament-workflow-http-'))
  let confirmBrowser
  const server = createTrackerServer({
    password, dataDir, demo, telegramToken: 'test-token', secureCookie: true,
    telegramFactory(options) {
      confirmBrowser = options.confirmBrowser
      return {
        loginUrl: (code) => `https://t.me/mock_reglament_bot?start=login_${code}`,
        currentActor: (actor) => actor,
        notifyPlan: () => {},
        close: () => {},
      }
    },
  })
  const agent = new Agent({ keepAlive: false })
  agent.createConnection = () => {
    const outgoing = new PassThrough()
    const incoming = new PassThrough()
    const client = Duplex.from({ readable: incoming, writable: outgoing })
    const socket = Duplex.from({ readable: outgoing, writable: incoming })
    socket.setTimeout = () => socket
    socket.destroySoon = () => socket.end()
    client.once('close', () => socket.destroy())
    server.emit('connection', socket)
    return client
  }
  t.after(async () => {
    agent.destroy()
    server.emit('close')
    await rm(dataDir, { recursive: true, force: true })
  })

  function request(path, { method = 'GET', body, cookie, site } = {}) {
    const payload = body === undefined ? undefined : JSON.stringify(body)
    const headers = payload === undefined ? {} : { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
    if (cookie) headers.Cookie = cookie
    if (site) headers['Sec-Fetch-Site'] = site
    return new Promise((resolve, reject) => {
      const request = httpRequest(`http://reglament.test${path}`, { method, agent, headers }, (response) => {
        const chunks = []
        response.on('data', (chunk) => chunks.push(chunk))
        response.on('end', () => {
          const setCookie = response.headers['set-cookie']?.[0]
          resolve({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks)), setCookie, cookie: setCookie?.split(';')[0] })
        })
        response.on('error', reject)
      })
      request.on('error', reject)
      request.end(payload)
    })
  }
  const post = (path, body, cookie) => request(path, { method: 'POST', body, cookie })
  const apply = (action, fields, cookie) => post(workflow, { action, ...fields }, cookie)
  const codeFrom = (login) => new URL(login.data.url).searchParams.get('start').slice('login_'.length)

  assert.equal((await request(workflow)).data.enabled, false)
  assert.deepEqual((await request(path)).data.roles[0].assignees, [seniorActor.username])
  const admin = await post('/api/admin/login', { password })
  assert.equal(admin.status, 200)
  assert.equal((await apply('enable', {}, admin.cookie)).status, 200)
  const guest = await request(workflow)
  assert.equal(guest.data.enabled, true)
  assert.equal(guest.data.actor, null)
  assert.deepEqual(guest.data.points, [])
  assert.deepEqual((await request(path)).data.roles[0].assignees, [])
  assert.equal((await post(status, { status: 'done', assignee: seniorActor.username })).status, 401)
  assert.equal((await post(`${path}/roles/${role.id}/sos`, { assignee: seniorActor.username })).status, 409)

  assert.equal((await request('/api/telegram/login', { method: 'POST', site: 'cross-site' })).status, 403)
  const seniorLogin = await post('/api/telegram/login')
  const volunteerLogin = await post('/api/telegram/login')
  assert.equal(seniorLogin.status, 200)
  assert.match(seniorLogin.setCookie, /HttpOnly.*SameSite=(?:Strict|Lax).*Secure/)
  assert.notEqual(seniorLogin.cookie, volunteerLogin.cookie)
  assert.equal((await request(workflow, { cookie: seniorLogin.cookie })).data.actor, null)
  assert.equal(confirmBrowser(codeFrom(seniorLogin), seniorActor), true)
  assert.equal(confirmBrowser(codeFrom(seniorLogin), volunteerActor), false)
  assert.equal((await request(workflow, { cookie: volunteerLogin.cookie })).data.actor, null)
  assert.equal(confirmBrowser(codeFrom(volunteerLogin), volunteerActor), true)
  assert.deepEqual((await request(workflow, { cookie: seniorLogin.cookie })).data.actor, { ...seniorActor, isAdmin: false })
  assert.deepEqual((await request(path, { cookie: seniorLogin.cookie })).data.roles[0].assignees, [seniorActor.username])
  assert.equal((await post(status, { status: 'done', assignee: seniorActor.username }, volunteerLogin.cookie)).status, 403)
  const activePoint = (await request(workflow, { cookie: seniorLogin.cookie })).data.points.find((point) => point.roleId === role.id)
  assert.equal(activePoint.seniorSource, 'default')
  assert.equal(activePoint.isSenior, true)
  const checked = await post(status, { status: 'done' }, seniorLogin.cookie)
  assert.equal(checked.status, 200)
  const updatedTask = checked.data.roles[0].tasks.find((item) => item.id === task.id)
  assert.deepEqual(updatedTask.assignees, [volunteerActor.username])
  assert.equal(updatedTask.status, 'done')
  assert.ok((await request(workflow, { cookie: admin.cookie })).data.audit.some((entry) => entry.action === 'task-status'))

  const proposed = await apply('propose-senior', { roleId: role.id, username: seniorActor.username }, admin.cookie)
  const proposal = proposed.data.points.find((point) => point.roleId === role.id).proposal
  assert.equal((await apply('accept-senior', { roleId: role.id, proposalId: proposal.id }, volunteerLogin.cookie)).status, 403)
  assert.equal((await apply('accept-senior', { roleId: role.id, proposalId: proposal.id }, seniorLogin.cookie)).status, 200)

  const sos = { roleId: role.id, type: 'sos', requestId: 'http-sos' }
  assert.equal((await apply('create-request', sos, volunteerLogin.cookie)).status, 403)
  assert.equal((await apply('create-request', sos, seniorLogin.cookie)).data.requests[0].type, 'sos')
  assert.deepEqual((await request(workflow, { cookie: volunteerLogin.cookie })).data.requests, [])
  assert.equal((await request('/api/telegram/login', { method: 'DELETE', cookie: seniorLogin.cookie })).status, 200)
  assert.equal((await request(workflow, { cookie: seniorLogin.cookie })).data.actor, null)
})
