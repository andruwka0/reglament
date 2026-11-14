import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { chmodSync, createReadStream, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, resolve, sep } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { pathToFileURL } from 'node:url'
import { createTelegram } from './telegram.mjs'
import { createTelegramLink } from './telegram-link.mjs'
import { createWorkflow, initialWorkflow, WorkflowError } from './workflow.mjs'

const statuses = new Set(['todo', 'doing', 'blocked', 'done'])
const idPattern = /^[A-Za-z0-9_-]{1,80}$/
const timePattern = /^(?:[01]\d|2[0-3]):[0-5]\d$/
const tokenPattern = /^[A-Za-z0-9_-]{43}$/
const cookieName = 'regatta_session'
const telegramCookie = 'regatta_telegram'
const sessionDuration = 12 * 60 * 60 * 1000
const loginWindow = 15 * 60 * 1000
const sosDurationMs = 5 * 60_000
const maxBodyBytes = 512 * 1024
const maxCoverBytes = 1024 * 1024
const maxListLength = 150
const maxEventStreams = 250
const streamHeartbeatMs = 20_000
const maxStreamBacklogBytes = maxBodyBytes * 2
const contentTypes = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.ico': 'image/x-icon',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
}
const jpegSignature = Buffer.from([0xff, 0xd8, 0xff])
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const coverSignatures = {
  'image/jpeg': (bytes) => bytes.subarray(0, 3).equals(jpegSignature),
  'image/png': (bytes) => bytes.subarray(0, 8).equals(pngSignature),
  'image/webp': (bytes) => bytes.length >= 20 && bytes.toString('latin1', 0, 4) === 'RIFF' &&
    bytes.toString('latin1', 8, 12) === 'WEBP' && ['VP8 ', 'VP8L', 'VP8X'].includes(bytes.toString('latin1', 12, 16)),
}

class RequestError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

function invalid(message) {
  throw new RequestError(400, message)
}

function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid('Ожидается объект с данными.')
  return value
}

function string(value, label, maxLength, required = false) {
  if (typeof value !== 'string') invalid(`Заполните поле «${label}».`)
  const normalized = value.trim()
  if (normalized.length > maxLength) invalid(`Поле «${label}» слишком длинное.`)
  if (required && !normalized) invalid(`Заполните поле «${label}».`)
  return normalized
}

function identifier(value) {
  if (typeof value !== 'string' || !idPattern.test(value)) invalid('Некорректный идентификатор.')
  return value
}

function date(value) {
  const normalized = string(value, 'Дата', 10)
  if (!normalized) return ''
  const parsed = new Date(`${normalized}T00:00:00.000Z`)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized) || !Number.isFinite(parsed.getTime()) ||
      parsed.toISOString().slice(0, 10) !== normalized) invalid('Укажите корректную дату.')
  return normalized
}

function time(value) {
  const normalized = string(value, 'Время', 5)
  if (normalized && !timePattern.test(normalized)) invalid('Укажите время в формате ЧЧ:ММ.')
  return normalized
}

function person(value) {
  const handle = string(value, 'Telegram', 33).toLowerCase().replace(/^@/, '')
  if (!handle) return ''
  if (!/^[a-z0-9_]{1,32}$/.test(handle)) invalid('Укажите имя пользователя Telegram, например @volunteer.')
  return `@${handle}`
}

function assignmentFields(item) {
  const { assignee = '', assignees: people = [assignee] } = item
  if (!Array.isArray(people) || people.length > maxListLength) {
    invalid(`Укажите список ответственных до ${maxListLength} человек.`)
  }
  const assignees = [...new Set(people.map(person).filter(Boolean))]
  return { assignees, assignee: assignees[0] ?? '' }
}

function status(value) {
  if (!statuses.has(value)) invalid('Выберите допустимый статус задачи.')
  return value
}

function items(value, map, seen = new Set()) {
  if (!Array.isArray(value) || value.length > maxListLength) {
    invalid(`Некорректный список. Допустимо до ${maxListLength} элементов.`)
  }
  return value.map((entry) => {
    const item = requireObject(entry)
    const id = identifier(item.id)
    if (seen.has(id)) invalid('В списке есть повторяющийся идентификатор.')
    seen.add(id)
    return { id, ...map(item) }
  })
}

function titleOf(value) {
  return string(value, 'Название', 160, true)
}

function descriptionOf(value) {
  return string(value, 'Описание', 6000)
}

function scheduleItem(item) {
  return {
    title: titleOf(item.title), description: descriptionOf(item.description),
    start: time(item.start), end: time(item.end),
  }
}

function planChanged(previous, next) {
  const schedule = (event) => {
    const fields = ({ title, description, start, end }) => [title, description, start, end]
    const tasks = [...event.tasks, ...event.roles.flatMap((role) => role.tasks)]
    return [event.date, event.timeline.map(fields), tasks.filter((task) => task.start || task.end).map(fields)]
  }
  return JSON.stringify(schedule(previous)) !== JSON.stringify(schedule(next))
}

function normalizeEvent(value, id, revision) {
  const event = requireObject(value)
  const taskIds = new Set()
  const taskList = (tasks) => items(tasks, (task) => ({
    ...scheduleItem(task), ...assignmentFields(task), status: status(task.status),
  }), taskIds)
  return {
    id, revision, title: titleOf(event.title), date: date(event.date),
    location: string(event.location, 'Место', 250), description: descriptionOf(event.description),
    info: items(event.info, (item) => {
      const label = string(item.label === undefined ? '' : item.label, 'Заголовок поля', 120)
      const value = string(item.value === undefined ? '' : item.value, label ? 'Значение' : 'Текст', 4000, !label)
      return { label, value }
    }),
    timeline: items(event.timeline, scheduleItem),
    roles: items(event.roles, (role) => ({
      title: titleOf(role.title), description: descriptionOf(role.description),
      ...assignmentFields(role), tasks: taskList(role.tasks),
    })),
    tasks: taskList(event.tasks),
  }
}

function readAssignments(event) {
  // Older databases store one normalized handle per role and task.
  const items = [...event.roles, ...event.roles.flatMap((role) => role.tasks), ...event.tasks]
  for (const item of items) item.assignees ??= item.assignee ? [item.assignee] : []
  return event
}

function importFields(value, path, defaults) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`В «${path}» ожидается объект.`)
  const unknown = Object.keys(value).find((field) => field !== 'id' && !Object.hasOwn(defaults, field))
  if (unknown !== undefined) invalid(`В «${path}» есть неизвестное поле «${unknown}».`)
  return { ...defaults, ...value, id: randomUUID() }
}

function importList(value, path, map) {
  if (!Array.isArray(value) || value.length > maxListLength) {
    invalid(`В «${path}» ожидается список до ${maxListLength} элементов.`)
  }
  return value.map((item, index) => map(item, `${path}[${index + 1}]`))
}

function prepareImport(body) {
  const event = importFields(body, 'мероприятие', {
    revision: 0, title: '', date: '', location: '', description: '', info: [], timeline: [], roles: [], tasks: [],
  })
  const schedule = { title: '', description: '', start: '', end: '' }
  const task = (value, path) => importFields(value, path, {
    ...schedule, assignee: '', assignees: undefined, status: 'todo',
  })
  event.info = importList(event.info, 'info', (value, path) => importFields(value, path, { label: '', value: '' }))
  event.timeline = importList(event.timeline, 'timeline', (value, path) => importFields(value, path, schedule))
  event.roles = importList(event.roles, 'roles', (value, path) => {
    const role = importFields(value, path, {
      title: '', description: '', assignee: '', assignees: undefined, tasks: [],
    })
    role.tasks = importList(role.tasks, `${path}.tasks`, task)
    return role
  })
  event.tasks = importList(event.tasks, 'tasks', task)
  return normalizeEvent(event, event.id, 0)
}

function cleanTemplate(event) {
  const resetTask = (task) => ({ ...task, assignee: '', assignees: [], status: 'todo' })
  return {
    ...event, date: '', revision: 0,
    roles: event.roles.map((role) => ({ ...role, assignee: '', assignees: [], tasks: role.tasks.map(resetTask) })),
    tasks: event.tasks.map(resetTask),
  }
}

function findTask(event, id) {
  const sharedTask = event.tasks.find((task) => task.id === id)
  if (sharedTask) return { task: sharedTask, assignees: sharedTask.assignees }
  for (const role of event.roles) {
    const task = role.tasks.find((item) => item.id === id)
    if (task) return { task, assignees: task.assignees.length ? task.assignees : role.assignees }
  }
  throw new RequestError(404, 'Задача не найдена.')
}

function secret() {
  return randomBytes(32).toString('base64url')
}

function digest(value) {
  return createHash('sha256').update(value).digest()
}

function openStore(dataDir, demo) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const filename = join(dataDir, 'regatta.sqlite')
  const db = new DatabaseSync(filename)
  chmodSync(filename, 0o600)
  db.exec(`
    PRAGMA busy_timeout = 5000;
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
  `)

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

  function synchronizeInvitations(event) {
    const assigned = new Set(event.tasks.flatMap((task) => task.assignees))
    for (const role of event.roles) {
      for (const assignee of role.assignees) assigned.add(assignee)
      for (const assignee of role.tasks.flatMap((task) => task.assignees)) assigned.add(assignee)
    }
    const current = db.prepare('SELECT assignee FROM invites WHERE event_id = ?').all(event.id)
    for (const { assignee } of current) {
      if (!assigned.delete(assignee)) {
        db.prepare('DELETE FROM invites WHERE event_id = ? AND assignee = ?').run(event.id, assignee)
      }
    }
    for (const assignee of assigned) {
      db.prepare('INSERT INTO invites VALUES (?, ?, ?)').run(event.id, assignee, secret())
    }
  }

  function insertEvent(event) {
    db.prepare('INSERT INTO events VALUES (?, ?)').run(event.id, JSON.stringify(event))
    synchronizeInvitations(event)
    return event
  }

  try {
    transaction(() => {
      const { user_version: version } = db.prepare('PRAGMA user_version').get()
      if (version < 1) {
        db.exec(`
          CREATE TABLE events (id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE templates (id TEXT PRIMARY KEY, data TEXT NOT NULL);
          CREATE TABLE invites (
            event_id TEXT NOT NULL REFERENCES events(id),
            assignee TEXT NOT NULL,
            token TEXT NOT NULL UNIQUE,
            PRIMARY KEY (event_id, assignee)
          );
        `)
        if (demo) insertEvent(normalizeEvent(demo, identifier(demo.id), 0))
      }
      if (version < 2) {
        db.exec(`
          CREATE TABLE covers (
            event_id TEXT PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
            version TEXT NOT NULL,
            mime TEXT NOT NULL,
            bytes BLOB NOT NULL
          );
          PRAGMA user_version = 2;
        `)
      }
    })
  } catch (error) {
    db.close()
    throw error
  }

  function getStoredEvent(id) {
    const row = db.prepare('SELECT data FROM events WHERE id = ?').get(id)
    if (!row) throw new RequestError(404, 'Мероприятие не найдено.')
    return readAssignments(JSON.parse(row.data))
  }

  function withCover(event, coverVersion) {
    return coverVersion ? { ...event, coverVersion } : event
  }

  function getEvent(id) {
    const row = db.prepare(`
      SELECT events.data, covers.version FROM events
      LEFT JOIN covers ON covers.event_id = events.id WHERE events.id = ?
    `).get(id)
    if (!row) throw new RequestError(404, 'Мероприятие не найдено.')
    return withCover(readAssignments(JSON.parse(row.data)), row.version)
  }

  function assigneeForToken(eventId, token) {
    if (!tokenPattern.test(token)) return undefined
    return db.prepare('SELECT assignee FROM invites WHERE event_id = ? AND token = ?')
      .get(eventId, token)?.assignee
  }

  return {
    close: () => db.close(),
    getEvent,
    getCover: (id) => {
      const cover = db.prepare('SELECT mime, bytes FROM covers WHERE event_id = ?').get(id)
      if (!cover) throw new RequestError(404, 'Обложка не найдена.')
      return cover
    },
    saveCover: (id, { mime, bytes }) => transaction(() => {
      const event = getStoredEvent(id)
      const version = randomUUID()
      db.prepare(`
        INSERT INTO covers VALUES (?, ?, ?, ?)
        ON CONFLICT (event_id) DO UPDATE SET version = excluded.version, mime = excluded.mime, bytes = excluded.bytes
      `).run(id, version, mime, bytes)
      return withCover(event, version)
    }),
    removeCover: (id) => transaction(() => {
      const event = getStoredEvent(id)
      db.prepare('DELETE FROM covers WHERE event_id = ?').run(id)
      return event
    }),
    assigneeForToken,
    catalog: () => ({
      events: db.prepare(`
        SELECT events.data, covers.version FROM events
        LEFT JOIN covers ON covers.event_id = events.id ORDER BY events.rowid DESC
      `).all().map(({ data, version }) => withCover(readAssignments(JSON.parse(data)), version)),
      templates: db.prepare('SELECT data FROM templates ORDER BY rowid DESC').all().map(({ data }) => {
        const template = JSON.parse(data)
        readAssignments(template.event)
        return template
      }),
    }),
    invites: (id) => {
      getEvent(id)
      return db.prepare('SELECT assignee, token FROM invites WHERE event_id = ? ORDER BY assignee').all(id)
    },
    createEvent: (body) => transaction(() => {
      let structure = { description: '', location: '', info: [], timeline: [], roles: [], tasks: [] }
      if (body.templateId) {
        const template = db.prepare('SELECT data FROM templates WHERE id = ?').get(identifier(body.templateId))
        if (!template) throw new RequestError(404, 'Шаблон не найден.')
        structure = JSON.parse(template.data).event
      }
      return insertEvent(normalizeEvent({ ...structure, title: body.title, date: body.date }, randomUUID(), 0))
    }),
    importEvent: (body) => {
      const event = prepareImport(body)
      return transaction(() => insertEvent(event))
    },
    updateEvent: (id, body, { enableWorkflow = false } = {}) => transaction(() => {
      const existing = getStoredEvent(id)
      if (body.id !== id) invalid('Идентификатор мероприятия не совпадает.')
      if (body.revision !== existing.revision) {
        throw new RequestError(409, 'Мероприятие уже изменилось. Обновите данные перед сохранением.')
      }
      const event = normalizeEvent(body, id, existing.revision + 1)
      db.prepare('UPDATE events SET data = ? WHERE id = ?').run(JSON.stringify(event), id)
      synchronizeInvitations(event)
      if (enableWorkflow) {
        db.prepare('INSERT OR IGNORE INTO event_workflow VALUES (?, ?)').run(id, JSON.stringify(initialWorkflow(id)))
      }
      return getEvent(id)
    }),
    createTemplate: ({ eventId, title }) => transaction(() => {
      const id = randomUUID()
      const event = cleanTemplate(getStoredEvent(identifier(eventId)))
      const template = { id, title: titleOf(title), event }
      db.prepare('INSERT INTO templates VALUES (?, ?)').run(id, JSON.stringify(template))
      return template
    }),
    updateTask: (eventId, taskId, nextStatus, { isAdmin, token, assignee }) => transaction(() => {
      let actor = ''
      if (token !== undefined) {
        actor = assigneeForToken(eventId, token)
        if (!actor) throw new RequestError(401, 'Личная ссылка недействительна.')
      } else if (!isAdmin || assignee !== undefined) {
        actor = person(assignee === undefined ? '' : assignee)
        if (!actor) throw new RequestError(403, 'Выберите участника в Telegram, чтобы изменить статус.')
      }
      const event = getStoredEvent(eventId)
      const { task, assignees } = findTask(event, taskId)
      if (actor && !assignees.includes(actor)) throw new RequestError(403, 'Эта задача не назначена выбранному участнику.')
      if (task.status !== nextStatus) {
        task.status = nextStatus
        event.revision++
        db.prepare('UPDATE events SET data = ? WHERE id = ?').run(JSON.stringify(event), eventId)
      }
      return getEvent(eventId)
    }),
  }
}

function contentType(request) {
  return request.headers['content-type']?.split(';')[0].trim().toLowerCase()
}

async function readBytes(request, limit, errorMessage) {
  if (Number(request.headers['content-length']) > limit) {
    request.resume()
    throw new RequestError(413, errorMessage)
  }
  let size = 0
  const chunks = []
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length
    if (size > limit) {
      request.resume()
      throw new RequestError(413, errorMessage)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readBody(request) {
  if (contentType(request) !== 'application/json') {
    throw new RequestError(415, 'Отправьте данные в формате JSON.')
  }
  const bytes = await readBytes(request, maxBodyBytes, 'Слишком большой объём данных.')
  let parsed
  try {
    parsed = JSON.parse(bytes.toString('utf8'))
  } catch {
    invalid('Некорректный JSON.')
  }
  return requireObject(parsed)
}

async function readCover(request) {
  const mime = contentType(request)
  if (!Object.hasOwn(coverSignatures, mime)) {
    throw new RequestError(415, 'Выберите изображение JPEG, PNG или WebP.')
  }
  const bytes = await readBytes(request, maxCoverBytes, 'Размер обложки должен быть не больше 1 МБ.')
  if (!coverSignatures[mime](bytes)) invalid('Содержимое файла не соответствует формату изображения.')
  return { mime, bytes }
}

function writeJson(response, code, body) {
  response.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  response.end(JSON.stringify(body))
}

function requestToken(request) {
  const authorization = request.headers.authorization
  if (authorization === undefined) return undefined
  return authorization.match(/^Bearer (\S+)$/i)?.[1] ?? ''
}

function requestCookie(request, name = cookieName) {
  return request.headers.cookie?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]*)`))?.[1]
}

async function staticFile(response, method, path, directory) {
  const filename = resolve(directory, `.${path}`)
  if (filename !== directory && !filename.startsWith(directory + sep)) {
    throw new RequestError(404, 'Страница не найдена.')
  }
  let file = filename
  let metadata = await stat(file).catch(() => null)
  if (!metadata?.isFile() && !extname(file)) {
    file = join(directory, 'index.html')
    metadata = await stat(file).catch(() => null)
  }
  if (!metadata?.isFile()) throw new RequestError(404, 'Страница не найдена.')
  response.writeHead(200, {
    'Content-Type': contentTypes[extname(file)] || 'application/octet-stream',
    'Content-Length': metadata.size,
    'Cache-Control': extname(file) === '.html' ? 'no-store' : 'no-cache',
  })
  if (method === 'HEAD') {
    response.end()
  } else {
    const stream = createReadStream(file)
    stream.on('error', (error) => response.destroy(error))
    response.on('close', () => stream.destroy())
    stream.pipe(response)
  }
}

export function createTrackerServer({
  password, dataDir = 'data', staticDir = 'dist/regatta-tracker/browser', demo, secureCookie = false,
  telegramToken, publicOrigin = 'https://reglament.andruwka.site', telegramFactory = createTelegram,
} = {}) {
  if (typeof password !== 'string' || (password.length < 12 && !/^[0-9]{4}$/.test(password))) {
    throw new Error('Задайте ADMIN_PASSWORD из четырёх цифр или длиной от 12 символов.')
  }
  const store = openStore(resolve(dataDir), demo)
  const directory = resolve(staticDir)
  const passwordHash = digest(password)
  const verifyAdminPassword = (value) => typeof value === 'string' && timingSafeEqual(passwordHash, digest(value))
  let telegramLink
  const telegram = telegramToken ? telegramFactory({
    token: telegramToken, dataDir: resolve(dataDir), publicOrigin, verifyAdminPassword,
    listEvents: () => store.catalog().events, getEvent: store.getEvent,
    confirmBrowser: (code, actor) => telegramLink.confirm(code, actor),
  }) : null
  telegramLink = createTelegramLink(telegram)
  const workflow = createWorkflow({ database: join(resolve(dataDir), 'regatta.sqlite'), getEvent: store.getEvent })
  const sessions = new Map()
  const loginAttempts = new Map()
  const eventStreams = new Map()
  const roleSosRequests = new Map()

  function writeStream(response, data) {
    if (response.destroyed || response.writableEnded) return
    if (response.writableLength > maxStreamBacklogBytes) response.destroy()
    else response.write(data)
  }

  function workflowActor(browser, isAdmin) {
    const linked = telegramLink.actor(browser)
    const actor = linked && telegram?.currentActor?.(linked)
    return actor || isAdmin ? { ...actor, isAdmin } : null
  }

  function eventFor(event, actor) {
    if (!workflow.enabled(event.id)) return event
    const safe = { ...event, managedWorkflow: true }
    if (actor?.isAdmin || (actor && (workflow.view(event.id, actor).points.length || event.tasks.some((task) => task.assignees.includes(actor.username))))) return safe
    const anonymous = (item) => ({ ...item, assignee: '', assignees: [] })
    return { ...safe, info: [], description: '', tasks: event.tasks.map(anonymous), roles: event.roles.map((role) => ({
      ...anonymous(role), tasks: role.tasks.map(anonymous),
    })) }
  }

  function streamEvent(id, cookie, browser, response) {
    const event = store.getEvent(id)
    if (eventStreams.size >= maxEventStreams) {
      throw new RequestError(503, 'Слишком много подключений. Обновления продолжат загружаться автоматически.')
    }
    response.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    })
    eventStreams.set(response, { id, cookie, browser })
    response.once('close', () => eventStreams.delete(response))
    writeStream(response, `retry: 3000\ndata: ${JSON.stringify(eventFor(event, workflowActor(browser, authenticated(cookie))))}\n\n`)
    if (authenticated(cookie)) {
      for (const { eventId, alert, cancelled } of roleSosRequests.values()) {
        if (eventId === id && alert.expiresAt > Date.now()) {
          writeStream(response, `event: ${cancelled ? 'sos-cancelled' : 'sos'}\ndata: ${JSON.stringify(alert)}\n\n`)
        }
      }
    }
  }

  function broadcast(eventId, data, name) {
    let frame
    const scoped = !name && workflow.enabled(eventId)
    for (const [stream, { id, cookie, browser }] of eventStreams) {
      if (id !== eventId || (name && name !== 'workflow' && !authenticated(cookie))) continue
      if (scoped) {
        writeStream(stream, `data: ${JSON.stringify(eventFor(data, workflowActor(browser, authenticated(cookie))))}\n\n`)
        continue
      }
      frame ??= `${name ? `event: ${name}\n` : ''}data: ${JSON.stringify(data)}\n\n`
      writeStream(stream, frame)
    }
  }

  function publishEvent(response, event) {
    writeJson(response, 200, event)
    broadcast(event.id, event)
  }

  async function handleRoleSos(eventId, roleId, request, response) {
    if (workflow.enabled(eventId)) throw new RequestError(409, 'SOS доступен старшему в карточке рабочей точки.')
    const assignee = person(request.method === 'GET'
      ? new URL(request.url, 'http://localhost').searchParams.get('assignee') ?? ''
      : (await readBody(request)).assignee ?? '')
    const role = store.getEvent(eventId).roles.find((item) => item.id === roleId)
    if (!role) throw new RequestError(404, 'Роль не найдена.')
    if (!assignee) throw new RequestError(403, 'Выберите участника в Telegram.')
    if (!role.assignees.includes(assignee) && !role.tasks.some((task) => task.assignees.includes(assignee))) {
      throw new RequestError(403, 'Эта роль не назначена выбранному участнику.')
    }

    const key = `${eventId}/${roleId}/${assignee}`
    const now = Date.now()
    const existing = roleSosRequests.get(key)
    const active = existing && !existing.cancelled && existing.alert.expiresAt > now
    if (request.method === 'GET') {
      return writeJson(response, 200, { expiresAt: active ? existing.alert.expiresAt : null })
    }
    if (request.method === 'DELETE') {
      if (active) {
        existing.cancelled = true
        broadcast(eventId, existing.alert, 'sos-cancelled')
      }
      return writeJson(response, 200, { cancelled: true })
    }
    if (active) {
      response.setHeader('Retry-After', Math.ceil((existing.alert.expiresAt - now) / 1000))
      throw new RequestError(429, 'SOS уже отправлен. Его можно отменить.')
    }
    const alert = { roleId, roleTitle: role.title, assignee, expiresAt: now + sosDurationMs }
    roleSosRequests.set(key, { eventId, alert, cancelled: false })
    broadcast(eventId, alert, 'sos')
    return writeJson(response, 200, { sent: true, expiresAt: alert.expiresAt })
  }

  function notifyWorkflow(event, body, view) {
    if (!telegram?.notifyWorkflow) return
    const point = view.points.find((entry) => entry.roleId === body.roleId)
    let notification
    if (body.action === 'propose-senior' && point?.proposal) {
      notification = { text: `Предложение стать старшим точки «${point.title}». Подтвердите в Регламенте.`, handles: [point.proposal.username] }
    } else if (body.action === 'create-command') {
      const targets = view.points.filter((entry) => body.roleIds.includes(entry.roleId))
      const handles = targets.map((entry) => entry.senior).filter(Boolean)
      notification = { text: 'Координатор отправил команду вашему посту. Откройте Регламент.', handles }
    } else if (body.action === 'create-request' && point) {
      const heading = { sos: 'Нужна помощь', question: 'Новый вопрос', report: 'Новый отчёт' }[body.type]
      notification = { text: `${heading} от точки «${point.title}». Откройте рабочий режим.`, coordinators: true }
    }
    if (!notification) return
    try {
      telegram.notifyWorkflow(event, notification)
    } catch {
      console.error('Не удалось поставить в очередь уведомление рабочего режима.')
    }
  }

  const heartbeat = setInterval(() => {
    for (const stream of eventStreams.keys()) writeStream(stream, ': heartbeat\n\n')
    const now = Date.now()
    for (const [key, { alert }] of roleSosRequests) {
      if (alert.expiresAt <= now) roleSosRequests.delete(key)
    }
  }, streamHeartbeatMs)
  heartbeat.unref()

  function setSession(response, token, age) {
    response.setHeader('Set-Cookie', [
      `${cookieName}=${token}`, 'Path=/', `Max-Age=${age}`, 'HttpOnly', 'SameSite=Strict',
      ...(secureCookie ? ['Secure'] : []),
    ].join('; '))
  }

  function setTelegramSession(response, browser, age) {
    response.setHeader('Set-Cookie', [
      `${telegramCookie}=${browser}`, 'Path=/', `Max-Age=${age}`, 'HttpOnly', 'SameSite=Lax',
      ...(secureCookie ? ['Secure'] : []),
    ].join('; '))
  }

  function authenticated(cookie) {
    const expiry = sessions.get(cookie)
    if (expiry > Date.now()) return true
    sessions.delete(cookie)
    return false
  }

  async function login(request, response, oldCookie) {
    const body = await readBody(request)
    const now = Date.now()
    for (const [key, entry] of loginAttempts) {
      if (entry.expires <= now) loginAttempts.delete(key)
    }
    const ip = request.socket.remoteAddress
    const entry = loginAttempts.get(ip) || { count: 0, expires: now + loginWindow }
    if (entry.count >= 15) {
      throw new RequestError(429, 'Слишком много попыток входа. Попробуйте позже.')
    }
    if (!verifyAdminPassword(body.password)) {
      entry.count++
      loginAttempts.set(ip, entry)
      throw new RequestError(401, 'Неверный пароль.')
    }
    loginAttempts.delete(ip)
    for (const [key, expires] of sessions) {
      if (expires <= now) sessions.delete(key)
    }
    sessions.delete(oldCookie)
    const token = secret()
    sessions.set(token, now + sessionDuration)
    setSession(response, token, sessionDuration / 1000)
    return writeJson(response, 200, { authenticated: true })
  }

  async function handle(request, response) {
    response.setHeader('X-Content-Type-Options', 'nosniff')
    response.setHeader('Referrer-Policy', 'no-referrer')
    response.setHeader('X-Frame-Options', 'DENY')
    let path
    try {
      path = decodeURIComponent(new URL(request.url, 'http://localhost').pathname)
    } catch {
      invalid('Некорректный адрес.')
    }
    if (path.includes('\0') || path.includes('\\')) invalid('Некорректный адрес.')
    const { method } = request
    if (path !== '/api' && !path.startsWith('/api/')) {
      if (method !== 'GET' && method !== 'HEAD') throw new RequestError(405, 'Этот метод недоступен.')
      return staticFile(response, method, path, directory)
    }
    if (method !== 'GET' && ['cross-site', 'same-site'].includes(request.headers['sec-fetch-site'])) {
      throw new RequestError(403, 'Откройте трекер, чтобы изменить данные.')
    }
    const cookie = requestCookie(request)
    const isAdmin = authenticated(cookie)
    const browser = requestCookie(request, telegramCookie)
    const actor = workflowActor(browser, isAdmin)
    const token = requestToken(request)
    if (path === '/api/health' && method === 'GET') return writeJson(response, 200, { ok: true })
    if (path === '/api/admin/session' && method === 'GET') return writeJson(response, 200, { authenticated: isAdmin })
    if (path === '/api/admin/login' && method === 'POST') return login(request, response, cookie)
    if (path === '/api/admin/logout' && method === 'POST') {
      sessions.delete(cookie)
      setSession(response, '', 0)
      return writeJson(response, 200, { authenticated: false })
    }
    if (path === '/api/telegram/login' && method === 'POST') {
      const started = telegramLink.start(browser)
      if (!started) throw new RequestError(503, 'Вход через Telegram пока недоступен.')
      setTelegramSession(response, started.browser, 12 * 60 * 60)
      return writeJson(response, 200, { url: started.url })
    }
    if (path === '/api/telegram/login' && method === 'DELETE') {
      telegramLink.logout(browser)
      setTelegramSession(response, '', 0)
      return writeJson(response, 200, { ok: true })
    }
    if (path.startsWith('/api/admin/')) {
      if (!isAdmin) throw new RequestError(401, 'Войдите в кабинет организатора.')
      if (path === '/api/admin/catalog' && method === 'GET') {
        const catalog = store.catalog()
        return writeJson(response, 200, { ...catalog, events: catalog.events.map((event) => eventFor(event, actor)) })
      }
      if (path === '/api/admin/events' && method === 'POST') {
        return writeJson(response, 201, store.createEvent(await readBody(request)))
      }
      if (path === '/api/admin/events/import' && method === 'POST') {
        return writeJson(response, 201, store.importEvent(await readBody(request)))
      }
      if (path === '/api/admin/templates' && method === 'POST') {
        return writeJson(response, 201, store.createTemplate(await readBody(request)))
      }
      const adminEvent = path.match(/^\/api\/admin\/events\/([^/]+)(?:\/(invites|cover|telegram|announcements))?$/)
      if (adminEvent) {
        const [, rawId, action] = adminEvent
        const id = identifier(rawId)
        if (action === 'invites' && method === 'GET') return writeJson(response, 200, store.invites(id))
        if (action === 'cover' && method === 'PUT') return publishEvent(response, store.saveCover(id, await readCover(request)))
        if (action === 'cover' && method === 'DELETE') return publishEvent(response, store.removeCover(id))
        if (action === 'telegram' && method === 'GET') {
          const event = store.getEvent(id)
          return writeJson(response, 200, telegram?.info(event) ?? { botUrl: null, recipients: 0, connected: 0 })
        }
        if (action === 'announcements' && method === 'POST') {
          const text = string((await readBody(request)).text, 'Сообщение', 3000, true)
          const event = store.getEvent(id)
          if (!telegram?.info(event).botUrl) throw new RequestError(503, 'Бот Telegram пока недоступен.')
          return writeJson(response, 202, telegram.announce(event, text))
        }
        if (!action && method === 'PUT') {
          const body = await readBody(request)
          const enableWorkflow = body.enableWorkflow === true
          const managed = workflow.enabled(id)
          const previous = telegram || managed ? store.getEvent(id) : null
          if (managed) {
            const statuses = new Map([...previous.tasks, ...previous.roles.flatMap((role) => role.tasks)]
              .map((task) => [task.id, task.status]))
            for (const task of [...(Array.isArray(body.tasks) ? body.tasks : []), ...(Array.isArray(body.roles) ? body.roles.flatMap((role) => Array.isArray(role?.tasks) ? role.tasks : []) : [])]) {
              if (task && typeof task === 'object') task.status = statuses.get(task.id) ?? 'todo'
            }
          }
          const event = store.updateEvent(id, body, { enableWorkflow })
          if (telegram && previous && !(enableWorkflow && !managed) && planChanged(previous, event)) {
            try {
              telegram.notifyPlan(event)
            } catch {
              console.error('Не удалось поставить в очередь уведомление об изменении плана.')
            }
          }
          writeJson(response, 200, eventFor(event, actor))
          broadcast(event.id, event)
          if (enableWorkflow) broadcast(event.id, {}, 'workflow')
          return
        }
      }
    }
    const roleSos = path.match(/^\/api\/events\/([^/]+)\/roles\/([^/]+)\/sos$/)
    if (roleSos && ['GET', 'POST', 'DELETE'].includes(method)) {
      return handleRoleSos(identifier(roleSos[1]), identifier(roleSos[2]), request, response)
    }
    const publicEvent = path.match(/^\/api\/events\/([^/]+)(?:\/(access|cover|stream|telegram|workflow|tasks\/([^/]+)\/status))?$/)
    if (publicEvent) {
      const [, rawEventId, action, taskId] = publicEvent
      const eventId = identifier(rawEventId)
      if (!action && method === 'GET') return writeJson(response, 200, eventFor(store.getEvent(eventId), actor))
      if (action === 'stream' && method === 'GET') return streamEvent(eventId, cookie, browser, response)
      if (action === 'workflow' && method === 'GET') return writeJson(response, 200, workflow.view(eventId, actor))
      if (action === 'workflow' && method === 'POST') {
        const body = await readBody(request)
        const before = workflow.view(eventId, actor)
        const view = workflow.apply(eventId, actor, body)
        if (view.audit[0]?.id !== before.audit[0]?.id) notifyWorkflow(store.getEvent(eventId), body, view)
        if (body.action === 'enable') broadcast(eventId, store.getEvent(eventId))
        broadcast(eventId, {}, 'workflow')
        return writeJson(response, 200, view)
      }
      if (action === 'telegram' && method === 'GET') {
        const event = store.getEvent(eventId)
        return writeJson(response, 200, { botUrl: telegram?.info(event).botUrl ?? null })
      }
      if (action === 'cover' && method === 'GET') {
        const { mime, bytes } = store.getCover(eventId)
        response.writeHead(200, { 'Content-Type': mime, 'Content-Length': bytes.length, 'Cache-Control': 'no-store' })
        return response.end(bytes)
      }
      if (action === 'access' && method === 'GET') {
        if (workflow.enabled(eventId)) throw new RequestError(401, 'Войдите через Telegram.')
        const assignee = store.assigneeForToken(eventId, token)
        if (!assignee) throw new RequestError(401, 'Личная ссылка недействительна.')
        return writeJson(response, 200, { assignee })
      }
      if (taskId && method === 'POST') {
        const body = await readBody(request)
        const id = identifier(taskId)
        const next = status(body.status)
        if (workflow.enabled(eventId)) {
          workflow.authorizeTask(eventId, id, actor, body)
          const previous = store.getEvent(eventId)
          const updated = store.updateTask(eventId, id, next, { isAdmin: true })
          if (updated.revision !== previous.revision) {
            workflow.recordTask(eventId, id, actor, body)
            broadcast(eventId, {}, 'workflow')
          }
          writeJson(response, 200, eventFor(updated, actor))
          return broadcast(eventId, updated)
        }
        const updated = store.updateTask(eventId, id, next, {
          isAdmin, token, assignee: body.assignee,
        })
        return publishEvent(response, updated)
      }
    }
    throw new RequestError(404, 'Страница не найдена.')
  }

  const server = createServer({ requestTimeout: 15_000, headersTimeout: 10_000 }, (request, response) => {
    handle(request, response).catch((error) => {
      if (response.headersSent) return response.destroy()
      if (error instanceof RequestError) return writeJson(response, error.status, { error: error.message })
      if (error instanceof WorkflowError) return writeJson(response, error.status, { error: error.message, code: error.code })
      console.error(error)
      return writeJson(response, 500, { error: 'Не удалось выполнить запрос. Попробуйте ещё раз.' })
    })
  })
  server.once('listening', () => telegram?.start())
  server.once('close', () => {
    clearInterval(heartbeat)
    for (const stream of eventStreams.keys()) stream.destroy()
    eventStreams.clear()
    telegram?.close()
    workflow.close()
    store.close()
  })
  return server
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const demoFile = new URL('demo.json', import.meta.url)
  const demo = existsSync(demoFile) ? JSON.parse(readFileSync(demoFile, 'utf8')) : undefined
  const host = process.env.HOST || '127.0.0.1'
  const port = Number(process.env.PORT || '3000')
  const server = createTrackerServer({
    password: process.env.ADMIN_PASSWORD,
    dataDir: process.env.DATA_DIR,
    staticDir: process.env.STATIC_DIR,
    secureCookie: process.env.SECURE_COOKIE === '1',
    telegramToken: process.env.TELEGRAM_BOT_TOKEN,
    publicOrigin: process.env.PUBLIC_ORIGIN,
    demo,
  })
  server.listen(port, host, () => console.log(`Трекер доступен по адресу http://${host}:${server.address().port}`))
}
