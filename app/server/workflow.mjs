import { createHash, randomUUID } from 'node:crypto'
import { DatabaseSync } from 'node:sqlite'

const general = { preparation: ['ready'], ready: ['preparation', 'working'], working: ['paused', 'finished'], paused: ['working', 'preparation', 'finished'] }
const intake = { preparation: ['ready'], ready: ['preparation', 'intake'], intake: ['paused'], paused: ['intake'] }
const transitions = { general, registration: intake, cloakroom: { ...intake, checkout_preparation: ['checkout'], checkout: ['finished'] } }
const commandTypes = new Set(['close_intake', 'prepare_checkout', 'request_status'])
const requestTypes = new Set(['sos', 'question', 'report'])
const closedRequests = new Set(['resolved', 'cancelled', 'closed'])

export class WorkflowError extends Error {
  constructor(status, code, message) {
    super(message)
    this.status = status
    this.code = code
  }
}

function fail(status, code, message) {
  throw new WorkflowError(status, code, message)
}

function text(value, required = false, limit = 2000) {
  if (value === undefined && !required) return ''
  if (typeof value !== 'string' || value.trim().length > limit || (required && !value.trim())) {
    fail(400, 'INVALID_TEXT', `Укажите текст длиной до ${limit} символов.`)
  }
  return value.trim()
}

function username(value) {
  if (typeof value !== 'string') return null
  const input = value.trim().toLowerCase().replace(/^@/, '')
  return /^[a-z0-9_]{1,32}$/.test(input) ? `@${input}` : null
}

function verified(actor) {
  const userId = typeof actor?.userId === 'string' || Number.isSafeInteger(actor?.userId) ? String(actor.userId) : null
  const isAdmin = actor?.isAdmin === true
  return isAdmin || userId ? { username: userId ? username(actor?.username) : null, userId, isAdmin } : null
}

function coordinator(actor) {
  if (!actor.isAdmin) fail(403, 'COORDINATOR_REQUIRED', 'Действие доступно координатору.')
}

function members(role) {
  const assignees = (item) => item.assignees ?? [item.assignee]
  return new Set([...(assignees(role)), ...role.tasks.flatMap(assignees)].map(username).filter(Boolean))
}

function initialPoint(roleId) {
  return { roleId, kind: 'general', status: 'preparation', version: 1, senior: null, seniorId: null,
    seniorSource: 'default', proposal: null }
}

const emptyState = () => ({ points: [], commands: [], requests: [], stages: [], audit: [], attempts: {} })
const emptyView = (enabled, actor) => ({ enabled, actor, points: [], commands: [], requests: [], stages: [], audit: [] })
const now = () => new Date().toISOString()
const actorLabel = (actor) => actor.username ?? (actor.isAdmin ? 'Координатор' : 'Участник')
const seniorOf = (point, actor) => Boolean(actor?.userId && (point.seniorId
  ? point.seniorId === actor.userId
  : point.seniorSource === 'default' && point.senior && point.senior === actor.username))
const canManage = (point, actor) => Boolean(actor?.isAdmin || seniorOf(point, actor))

export function initialWorkflow(eventId) {
  const state = emptyState()
  state.audit.push({ id: randomUUID(), roleId: null, action: 'enable', targetId: eventId,
    actor: 'Координатор', createdAt: now(), details: {} })
  return state
}

function requireSenior(point, actor) {
  if (!seniorOf(point, actor)) fail(403, 'SENIOR_REQUIRED', 'Действие доступно действующему старшему точки.')
  point.seniorId ??= actor.userId
}

function requireManager(point, actor) {
  if (!canManage(point, actor)) fail(403, 'POINT_ACCESS_REQUIRED', 'Действие доступно старшему этой точки и координатору.')
  if (!actor.isAdmin) point.seniorId ??= actor.userId
}

function findRole(event, roleId) {
  const role = event.roles.find((item) => item.id === roleId)
  if (!role) fail(404, 'POINT_NOT_FOUND', 'Точка не найдена.')
  return role
}

function resolvePoint(state, role, point) {
  if (!point.seniorSource) {
    if (point.seniorId) point.seniorSource = 'manual'
    else if (state.audit.some((entry) => entry.roleId === role.id && entry.action === 'revoke-senior')) point.seniorSource = 'revoked'
    else point.seniorSource = 'default'
  }
  if (point.seniorSource === 'default') {
    const first = username(role.assignees ? role.assignees[0] : role.assignee)
    if (point.senior !== first) point.seniorId = null
    point.senior = first
  }
  return point
}

function pointFor(state, role) {
  let point = state.points.find((item) => item.roleId === role.id)
  if (!point) {
    point = initialPoint(role.id)
    state.points.push(point)
  }
  return resolvePoint(state, role, point)
}

export function createWorkflow({ database, getEvent }) {
  const db = new DatabaseSync(database, { timeout: 1000 })
  db.exec('CREATE TABLE IF NOT EXISTS event_workflow (event_id TEXT PRIMARY KEY, data TEXT NOT NULL)')
  const read = db.prepare('SELECT data FROM event_workflow WHERE event_id = ?')
  const save = db.prepare('INSERT INTO event_workflow VALUES (?, ?) ON CONFLICT(event_id) DO UPDATE SET data = excluded.data')
  const load = (eventId) => JSON.parse(read.get(eventId)?.data ?? 'null')

  function transaction(run) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = run()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  function record(state, actor, action, targetId, roleId = null, details = {}) {
    state.audit.push({ id: randomUUID(), roleId, action, targetId, actor: actorLabel(actor), createdAt: now(), details })
  }

  function snapshot(event, state, actor) {
    const view = emptyView(Boolean(state), actor)
    if (!state || !actor) return view
    const managed = new Set()
    for (const role of event.roles) {
      const point = resolvePoint(state, role, state.points.find((item) => item.roleId === role.id) ?? initialPoint(role.id))
      const member = members(role).has(actor.username)
      const isSenior = seniorOf(point, actor)
      const manage = canManage(point, actor)
      if (manage) managed.add(role.id)
      if (!manage && !member) continue
      const { seniorId, proposal, ...visible } = point
      const proposalVisible = proposal && (actor.isAdmin || (proposal.username === actor.username &&
        (!proposal.userId || proposal.userId === actor.userId)))
      view.points.push({ ...visible, title: role.title, roleTitle: role.title, member, isSenior, canManage: manage,
        proposal: proposalVisible ? { id: proposal.id, username: proposal.username } : null })
    }
    view.commands = state.commands.map(({ targets, ...command }) => ({ ...command,
      targets: targets.filter((target) => managed.has(target.roleId)) })).filter((command) => command.targets.length)
    view.requests = state.requests.filter((request) => managed.has(request.roleId)).toReversed()
    view.audit = state.audit.filter((entry) => actor.isAdmin || managed.has(entry.roleId)).slice(-100).reverse()
    if (actor.isAdmin || view.points.length) {
      view.stages = event.timeline.map((item) => {
        const stage = state.stages.find((stage) => stage.stageId === item.id)
        return { stageId: item.id, title: item.title, start: item.start, end: item.end, status: stage?.status ?? 'planned',
          startedAt: stage?.startedAt ?? null, finishedAt: stage?.finishedAt ?? null }
      })
    }
    return view
  }

  function createCommand(event, state, actor, body) {
    coordinator(actor)
    if (!commandTypes.has(body.type)) fail(400, 'INVALID_COMMAND', 'Выберите известный тип команды.')
    if (!Array.isArray(body.roleIds) || !body.roleIds.length || body.roleIds.length > event.roles.length) {
      fail(400, 'INVALID_TARGETS', 'Выберите точки для команды.')
    }
    const roleIds = [...new Set(body.roleIds)]
    const command = { id: randomUUID(), type: body.type, message: text(body.message), createdAt: now(), targets: [] }
    for (const roleId of roleIds) {
      const point = pointFor(state, findRole(event, roleId))
      if ((body.type === 'close_intake' && point.kind === 'general') ||
          (body.type === 'prepare_checkout' && point.kind !== 'cloakroom')) {
        fail(422, 'INVALID_TARGET', 'Команда недоступна для выбранного типа точки.')
      }
      command.targets.push({ roleId, status: 'pending', acknowledgedAt: null, executedAt: null })
      record(state, actor, body.action, command.id, roleId, { type: command.type })
    }
    state.commands.push(command)
  }

  function handleCommand(state, point, actor, body) {
    requireSenior(point, actor)
    const command = state.commands.find((item) => item.id === body.commandId)
    const target = command?.targets.find((item) => item.roleId === point.roleId)
    if (!target) fail(404, 'COMMAND_NOT_FOUND', 'Команда для этой точки не найдена.')
    if (target.status === 'executed' || (target.status === 'acknowledged' && body.action === 'ack-command')) return
    const time = now()
    if (body.action === 'execute-command') {
      if (command.type === 'close_intake') {
        if (point.kind === 'general' || !['intake', 'paused'].includes(point.status)) fail(422, 'INVALID_TRANSITION', 'Сначала откройте приём.')
        point.status = 'intake_closed'
        point.version++
      } else if (command.type === 'prepare_checkout') {
        if (point.kind !== 'cloakroom' || point.status !== 'intake_closed') fail(422, 'INVALID_TRANSITION', 'Сначала закройте приём.')
        point.status = 'checkout_preparation'
        point.version++
      }
      target.status = 'executed'
      target.executedAt = time
    } else {
      target.status = 'acknowledged'
    }
    target.acknowledgedAt ??= time
    record(state, actor, body.action, command.id, point.roleId, { type: command.type, pointStatus: point.status })
  }

  function addMessage(request, actor, value) {
    request.messages.push({ id: randomUUID(), author: actorLabel(actor), text: value, createdAt: now() })
  }

  function createRequest(state, point, actor, body) {
    requireSenior(point, actor)
    if (!requestTypes.has(body.type)) fail(400, 'INVALID_REQUEST', 'Выберите тип обращения.')
    const message = text(body.text, body.type !== 'sos')
    if (body.type === 'sos' && state.requests.some((item) => item.roleId === point.roleId && item.type === 'sos' && !closedRequests.has(item.status))) {
      fail(409, 'ACTIVE_SOS_EXISTS', 'У точки уже есть открытое обращение SOS.')
    }
    const request = { id: randomUUID(), roleId: point.roleId, type: body.type, status: body.type === 'question' ? 'waiting' : 'new',
      author: actorLabel(actor), createdAt: now(), acceptedBy: null, closedAt: null, messages: [] }
    if (message) addMessage(request, actor, message)
    state.requests.push(request)
    record(state, actor, body.action, request.id, point.roleId, { type: request.type })
  }

  function handleRequest(event, state, actor, body) {
    const request = state.requests.find((item) => item.id === body.id)
    if (!request) fail(404, 'REQUEST_NOT_FOUND', 'Обращение не найдено.')
    const point = pointFor(state, findRole(event, request.roleId))
    requireManager(point, actor)
    if (closedRequests.has(request.status)) fail(409, 'REQUEST_CLOSED', 'Обращение уже закрыто.')
    const { type, status } = request
    let next
    switch (body.action) {
      case 'message-request':
        addMessage(request, actor, text(body.text, true))
        if (type === 'question') next = actor.isAdmin ? 'answered' : 'waiting'
        break
      case 'accept-request':
        coordinator(actor)
        if ((type === 'sos' && status === 'new') || (type === 'question' && status === 'waiting')) {
          next = 'in_progress'
          request.acceptedBy = actorLabel(actor)
        }
        break
      case 'resolve-request':
        coordinator(actor)
        if (type === 'sos' && status === 'in_progress') next = 'resolved'
        break
      case 'cancel-request':
        requireSenior(point, actor)
        if (type === 'sos') next = 'cancelled'
        break
      case 'close-request':
        if (type === 'question') next = 'closed'
        break
      case 'view-request':
        coordinator(actor)
        if (type === 'report' && status === 'new') next = 'viewed'
        break
      default: break
    }
    if (!next && body.action !== 'message-request') fail(422, 'INVALID_TRANSITION', 'Действие недоступно для этого обращения.')
    if (next) request.status = next
    if (closedRequests.has(request.status)) request.closedAt = now()
    record(state, actor, body.action, request.id, point.roleId, { status: request.status })
  }

  function configurePoint(point, actor, body) {
    coordinator(actor)
    if (!Object.hasOwn(transitions, body.kind)) fail(400, 'INVALID_POINT_KIND', 'Выберите тип точки.')
    if (point.kind === body.kind) return false
    if (point.status !== 'preparation') fail(422, 'INVALID_TRANSITION', 'Тип точки можно сменить только во время подготовки.')
    point.kind = body.kind
    point.version++
    return true
  }

  function changeSenior(state, point, role, actor, body) {
    if (body.action === 'propose-senior') {
      coordinator(actor)
      const candidate = username(body.username)
      if (!candidate || !members(role).has(candidate)) fail(400, 'INVALID_CANDIDATE', 'Выберите назначенного на точку участника.')
      if (point.seniorSource === 'manual' && point.senior === candidate) fail(409, 'ALREADY_SENIOR', 'Участник уже старший этой точки.')
      point.proposal = { id: randomUUID(), username: candidate,
        userId: point.senior === candidate ? point.seniorId : null }
      return
    }
    if (body.action === 'revoke-senior') {
      coordinator(actor)
      point.seniorSource = 'revoked'
      point.senior = point.seniorId = null
      return
    }
    if (body.action === 'restore-default-senior') {
      coordinator(actor)
      if (point.seniorSource !== 'default') {
        point.seniorSource = 'default'
        point.senior = point.seniorId = null
        resolvePoint(state, role, point)
      }
      return
    }
    if (!point.proposal || point.proposal.id !== body.proposalId) fail(409, 'STALE_PROPOSAL', 'Предложение уже изменилось.')
    if (body.action === 'revoke-proposal') coordinator(actor)
    else if (!actor.userId || !actor.username || point.proposal.username !== actor.username ||
      (point.proposal.userId && point.proposal.userId !== actor.userId) || !members(role).has(actor.username)) {
      fail(403, 'PROPOSAL_ACCESS_REQUIRED', 'Ответить может только назначенный участник.')
    }
    if (body.action === 'accept-senior') {
      point.seniorSource = 'manual'
      point.senior = actor.username
      point.seniorId = actor.userId
    }
    point.proposal = null
  }

  function changeStage(event, state, actor, body) {
    coordinator(actor)
    if (!event.timeline.some((item) => item.id === body.stageId)) fail(404, 'STAGE_NOT_FOUND', 'Этап не найден.')
    let stage = state.stages.find((item) => item.stageId === body.stageId)
    if (!stage) {
      stage = { stageId: body.stageId, status: 'planned', startedAt: null, finishedAt: null }
      state.stages.push(stage)
    }
    if (!['started', 'finished'].includes(body.status)) fail(400, 'INVALID_STAGE_STATUS', 'Выберите действие для этапа.')
    if (stage.status === body.status) return
    if ((stage.status === 'planned' && body.status !== 'started') || stage.status === 'finished') {
      fail(422, 'INVALID_TRANSITION', 'Этап необходимо начать, прежде чем завершить.')
    }
    stage.status = body.status
    stage[body.status === 'started' ? 'startedAt' : 'finishedAt'] = now()
    record(state, actor, body.action, stage.stageId, null, { status: stage.status })
  }

  function applyAction(event, state, actor, body) {
    switch (body.action) {
      case 'create-command': return createCommand(event, state, actor, body)
      case 'mark-stage': return changeStage(event, state, actor, body)
      case 'accept-request': case 'resolve-request': case 'cancel-request': case 'close-request': case 'view-request': case 'message-request':
        return handleRequest(event, state, actor, body)
      default: break
    }
    const role = findRole(event, body.roleId)
    const point = pointFor(state, role)
    switch (body.action) {
      case 'ack-command': case 'execute-command': return handleCommand(state, point, actor, body)
      case 'create-request': return createRequest(state, point, actor, body)
      case 'configure-point':
        if (!configurePoint(point, actor, body)) return
        record(state, actor, body.action, role.id, role.id, { kind: point.kind })
        return
      case 'propose-senior': case 'accept-senior': case 'decline-senior': case 'revoke-proposal': case 'revoke-senior': case 'restore-default-senior': {
        const before = point.senior
        const proposed = point.proposal?.username
        changeSenior(state, point, role, actor, body)
        point.version++
        record(state, actor, body.action, role.id, role.id, { previousSenior: before, senior: point.senior,
          seniorSource: point.seniorSource, proposed: point.proposal?.username ?? proposed ?? null })
        return
      }
      case 'set-point-status': {
        requireManager(point, actor)
        if (!Number.isSafeInteger(body.expectedVersion)) fail(400, 'VERSION_REQUIRED', 'Обновите данные точки перед изменением.')
        if (point.version !== body.expectedVersion) fail(409, 'STALE_POINT', 'Точка уже изменилась. Обновите данные.')
        if (!transitions[point.kind][point.status]?.includes(body.status)) fail(422, 'INVALID_TRANSITION', 'Переход недоступен. Для закрытия приёма нужна команда координатора.')
        const reason = text(body.reason, body.status === 'paused')
        const from = point.status
        point.status = body.status
        point.version++
        record(state, actor, body.action, role.id, role.id, { from, status: point.status, reason })
        return
      }
      default: fail(400, 'INVALID_ACTION', 'Неизвестное действие.')
    }
  }

  function authorizeTask(eventId, taskId, identity, body = {}) {
    const state = load(eventId)
    if (!state) return
    const actor = verified(identity)
    if (!actor) fail(401, 'SIGN_IN_REQUIRED', 'Войдите через Telegram или в кабинет организатора.')
    const event = getEvent(eventId)
    const role = event.roles.find((role) => role.tasks.some((task) => task.id === taskId))
    if (!role && !event.tasks.some((task) => task.id === taskId)) fail(404, 'TASK_NOT_FOUND', 'Задача не найдена.')
    if (role && seniorOf(pointFor(state, role), actor)) {
      text(body.comment)
      return
    }
    if (!actor.isAdmin) fail(403, 'SENIOR_REQUIRED', 'Отметить задачу может старший точки.')
    text(body.comment, true)
  }

  return {
    close: () => db.close(),
    enabled: (eventId) => Boolean(read.get(eventId)),
    view: (eventId, actor) => snapshot(getEvent(eventId), load(eventId), verified(actor)),
    apply(eventId, identity, body) {
      const actor = verified(identity)
      if (!actor) fail(401, 'SIGN_IN_REQUIRED', 'Войдите через Telegram или в кабинет организатора.')
      if (!body || typeof body.action !== 'string') fail(400, 'INVALID_ACTION', 'Неизвестное действие.')
      const event = getEvent(eventId)
      return transaction(() => {
        let state = load(eventId)
        if (body.action === 'enable') {
          coordinator(actor)
          if (!state) {
            state = initialWorkflow(eventId)
            save.run(eventId, JSON.stringify(state))
          }
          return snapshot(event, state, actor)
        }
        if (!state) fail(409, 'WORKFLOW_DISABLED', 'Рабочий режим для мероприятия ещё не включён.')
        const idempotent = body.action === 'create-request' || body.action === 'create-command'
        if (idempotent && (typeof body.requestId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(body.requestId))) {
          fail(400, 'REQUEST_ID_REQUIRED', 'Укажите идентификатор действия для безопасного повтора.')
        }
        const key = idempotent ? `${actor.userId ?? 'coordinator'}:${body.requestId}` : null
        const signature = key ? createHash('sha256').update(JSON.stringify(body)).digest('hex') : null
        if (key && state.attempts[key]) {
          if (state.attempts[key] !== signature) fail(409, 'REQUEST_ID_CONFLICT', 'Этот идентификатор уже использован для другого действия.')
          return snapshot(event, state, actor)
        }
        applyAction(event, state, actor, body)
        if (key) state.attempts[key] = signature
        save.run(eventId, JSON.stringify(state))
        return snapshot(event, state, actor)
      })
    },
    authorizeTask,
    recordTask(eventId, taskId, identity, body) {
      const event = getEvent(eventId)
      transaction(() => {
        const state = load(eventId)
        if (!state) return
        const role = event.roles.find((role) => role.tasks.some((task) => task.id === taskId))
        const actor = verified(identity)
        if (role) {
          const point = pointFor(state, role)
          if (seniorOf(point, actor)) point.seniorId ??= actor.userId
        }
        record(state, actor, 'task-status', taskId, role?.id ?? null, { status: body.status, comment: text(body.comment) })
        save.run(eventId, JSON.stringify(state))
      })
    },
  }
}
