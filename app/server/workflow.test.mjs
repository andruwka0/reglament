import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { createWorkflow } from './workflow.mjs'

const coordinator = { isAdmin: true }
const anna = { username: '@anna', userId: '101' }
const boris = { username: '@boris', userId: '102' }
const cyril = { username: '@cyril', userId: '103' }
const foreign = { username: '@foreign', userId: '104' }
const event = {
  id: 'regata',
  roles: [
    { id: 'registration', title: 'Регистрация', assignees: [anna.username, boris.username], tasks: [{ id: 'reg-task' }] },
    { id: 'coatroom', title: 'Гардероб', assignees: [], tasks: [{ id: 'coat-task', assignees: [cyril.username] }] },
  ],
  tasks: [{ id: 'common-task' }],
  timeline: [{ id: 'meet', title: 'Брифинг', start: '14:00', end: '' }],
}

async function testWorkflow(t) {
  const directory = await mkdtemp(join(tmpdir(), 'reglament-workflow-'))
  const options = { database: join(directory, 'regatta.sqlite'), getEvent: (id) => {
    if (id !== event.id) throw Object.assign(new Error('Missing event'), { status: 404 })
    return event
  } }
  let workflow = createWorkflow(options)
  t.after(async () => {
    workflow.close()
    await rm(directory, { recursive: true, force: true })
  })
  function apply(actor, action, body) { return workflow.apply(event.id, actor, { ...body, action }) }
  function status(actor, roleId, next, reason) {
    const expectedVersion = view(actor).points.find((point) => point.roleId === roleId).version
    return apply(actor, 'set-point-status', { roleId, status: next, expectedVersion, reason })
  }
  function view(actor) { return workflow.view(event.id, actor) }
  function appoint(person, roleId) {
    const proposed = apply(coordinator, 'propose-senior', { roleId, username: person.username })
    const proposal = proposed.points.find((point) => point.roleId === roleId).proposal
    return apply(person, 'accept-senior', { roleId, proposalId: proposal.id })
  }
  return { apply, status, view, appoint, get workflow() { return workflow }, restart() {
    workflow.close()
    workflow = createWorkflow(options)
  } }
}

function rejects(action, status, code) {
  assert.throws(action, { status, code })
}

test('workflows are opt-in and senior handover is consent-based and uses the accepted Telegram identity', async (t) => {
  const app = await testWorkflow(t)
  const roleId = 'registration'
  assert.equal(app.view().enabled, false)
  assert.doesNotThrow(() => app.workflow.authorizeTask(event.id, 'reg-task', null, {}))
  rejects(() => app.apply(anna, 'enable'), 403, 'COORDINATOR_REQUIRED')
  app.apply(coordinator, 'enable')
  assert.deepEqual(app.view({ username: anna.username }), { enabled: true, actor: null, points: [], commands: [], requests: [], stages: [], audit: [] })
  assert.equal(app.view(foreign).points.length, 0)
  assert.equal(app.view(anna).points[0].canManage, false)
  rejects(() => app.workflow.authorizeTask(event.id, 'reg-task', anna), 403, 'SENIOR_REQUIRED')
  rejects(() => app.apply(coordinator, 'propose-senior', { roleId, username: foreign.username }), 400, 'INVALID_CANDIDATE')

  app.appoint(anna, roleId)
  const proposal = app.apply(coordinator, 'propose-senior', { roleId, username: boris.username }).points[0].proposal
  assert.equal(app.view(anna).points[0].isSenior, true)
  assert.equal(app.view(anna).points[0].proposal, null)
  assert.deepEqual(app.view(boris).points[0].proposal, proposal)
  rejects(() => app.apply(cyril, 'accept-senior', { roleId, proposalId: proposal.id }), 403, 'PROPOSAL_ACCESS_REQUIRED')
  app.apply(boris, 'accept-senior', { roleId, proposalId: proposal.id })
  assert.equal(app.view(anna).points[0].isSenior, false)
  assert.equal(app.view(anna).points[0].member, true)
  assert.equal(app.view(boris).points[0].isSenior, true)
  assert.equal(app.view({ ...boris, username: '@changed' }).points[0].isSenior, true)
  rejects(() => app.workflow.authorizeTask(event.id, 'reg-task', anna), 403, 'SENIOR_REQUIRED')
  rejects(() => app.workflow.authorizeTask(event.id, 'reg-task', { username: boris.username, userId: foreign.userId }), 403, 'SENIOR_REQUIRED')
  assert.doesNotThrow(() => app.workflow.authorizeTask(event.id, 'reg-task', boris))
  rejects(() => app.workflow.authorizeTask(event.id, 'common-task', coordinator), 400, 'INVALID_TEXT')
  app.workflow.authorizeTask(event.id, 'common-task', coordinator, { comment: 'Проверено на месте' })
  app.workflow.recordTask(event.id, 'common-task', coordinator, { status: 'done', comment: 'Проверено на месте' })
  app.restart()
  assert.equal(app.view(boris).points[0].isSenior, true)
  assert.equal(app.view(coordinator).audit[0].action, 'task-status')
  app.apply(coordinator, 'revoke-senior', { roleId })
  assert.equal(app.view(boris).points[0].isSenior, false)
})

test('closing intake and preparing checkout require targeted coordinator commands; stages have explicit actual times', async (t) => {
  const app = await testWorkflow(t)
  const roleId = 'coatroom'
  app.apply(coordinator, 'enable')
  app.apply(coordinator, 'configure-point', { roleId, kind: 'cloakroom' })
  app.appoint(cyril, roleId)
  app.status(cyril, roleId, 'ready')
  app.status(cyril, roleId, 'intake')
  rejects(() => app.status(cyril, roleId, 'intake_closed'), 422, 'INVALID_TRANSITION')
  rejects(() => app.status(cyril, roleId, 'paused'), 400, 'INVALID_TEXT')
  rejects(() => app.apply(cyril, 'set-point-status', { roleId, status: 'paused', reason: 'Перерыв', expectedVersion: 1 }), 409, 'STALE_POINT')
  app.status(cyril, roleId, 'paused', 'Нужна помощь на входе')
  const commandBody = { roleIds: [roleId], type: 'close_intake', requestId: 'close-1' }
  const command = app.apply(coordinator, 'create-command', commandBody).commands[0]
  assert.equal(app.apply(coordinator, 'create-command', commandBody).commands.length, 1)
  rejects(() => app.apply(coordinator, 'create-command', { ...commandBody, message: 'Изменилось' }), 409, 'REQUEST_ID_CONFLICT')
  rejects(() => app.apply(coordinator, 'execute-command', { roleId, commandId: command.id }), 403, 'SENIOR_REQUIRED')
  assert.equal(app.view(anna).commands.length, 0)
  const acknowledged = app.apply(cyril, 'ack-command', { roleId, commandId: command.id })
  assert.equal(acknowledged.commands[0].targets[0].status, 'acknowledged')
  assert.equal(acknowledged.points[0].status, 'paused')
  const executed = app.apply(cyril, 'execute-command', { roleId, commandId: command.id })
  assert.equal(executed.points[0].status, 'intake_closed')
  assert.equal(executed.commands[0].targets[0].status, 'executed')
  assert.equal(app.apply(cyril, 'execute-command', { roleId, commandId: command.id }).points[0].version, executed.points[0].version)
  const prepare = app.apply(coordinator, 'create-command', { roleIds: [roleId], type: 'prepare_checkout', requestId: 'prepare-1' }).commands[1]
  app.apply(cyril, 'execute-command', { roleId, commandId: prepare.id })
  app.status(cyril, roleId, 'checkout')
  assert.equal(app.status(cyril, roleId, 'finished').points[0].status, 'finished')

  assert.equal(app.view(cyril).stages[0].status, 'planned')
  rejects(() => app.apply(cyril, 'mark-stage', { stageId: 'meet', status: 'started' }), 403, 'COORDINATOR_REQUIRED')
  rejects(() => app.apply(coordinator, 'mark-stage', { stageId: 'meet', status: 'finished' }), 422, 'INVALID_TRANSITION')
  const started = app.apply(coordinator, 'mark-stage', { stageId: 'meet', status: 'started' }).stages[0]
  const finished = app.apply(coordinator, 'mark-stage', { stageId: 'meet', status: 'finished' }).stages[0]
  assert.equal(finished.startedAt, started.startedAt)
  assert.ok(Date.parse(finished.finishedAt) >= Date.parse(started.startedAt))
})

test('SOS, questions, and reports use separate private lifecycles without changing point status', async (t) => {
  const app = await testWorkflow(t)
  const roleId = 'registration'
  app.apply(coordinator, 'enable')
  app.appoint(anna, roleId)
  const sos = { roleId, type: 'sos', requestId: 'send-once' }
  rejects(() => app.apply(boris, 'create-request', sos), 403, 'SENIOR_REQUIRED')
  const { id } = app.apply(anna, 'create-request', sos).requests[0]
  assert.equal(app.apply(anna, 'create-request', sos).requests[0].id, id)
  rejects(() => app.apply(anna, 'create-request', { ...sos, requestId: 'retry-another-key' }), 409, 'ACTIVE_SOS_EXISTS')
  assert.deepEqual(app.view(boris).requests, [])
  assert.equal(app.apply(coordinator, 'message-request', { id, text: 'Где вы?' }).requests[0].status, 'new')
  rejects(() => app.apply(coordinator, 'resolve-request', { id }), 422, 'INVALID_TRANSITION')
  app.apply(coordinator, 'accept-request', { id })
  const state = app.apply(coordinator, 'resolve-request', { id })
  assert.equal(state.requests[0].status, 'resolved')
  assert.equal(state.points[0].status, 'preparation')
  const another = app.apply(anna, 'create-request', { ...sos, requestId: 'second' }).requests[0]
  assert.equal(app.apply(anna, 'cancel-request', { id: another.id }).requests[0].status, 'cancelled')
  const question = app.apply(anna, 'create-request', { roleId, type: 'question', text: 'Где работать?', requestId: 'question' }).requests[0]
  assert.equal(question.status, 'waiting')
  assert.equal(app.apply(coordinator, 'message-request', { id: question.id, text: 'На первом этаже.' }).requests[0].status, 'answered')
  assert.equal(app.apply(anna, 'close-request', { id: question.id }).requests[0].status, 'closed')
  const report = app.apply(anna, 'create-request', { roleId, type: 'report', text: 'Пост готов', requestId: 'report' }).requests[0]
  assert.equal(app.apply(coordinator, 'view-request', { id: report.id }).requests[0].status, 'viewed')
  app.restart()
  assert.deepEqual(app.view(coordinator).requests.map((request) => request.status), ['viewed', 'closed', 'cancelled', 'resolved'])
  assert.match(app.view(anna).requests[1].messages.at(-1).text, /первом этаже/)
})
