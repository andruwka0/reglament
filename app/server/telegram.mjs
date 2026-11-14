import { createHash, randomBytes } from 'node:crypto'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { setTimeout as sleep } from 'node:timers/promises'

const authLifetime = 12 * 60 * 60 * 1000
const attemptWindow = 15 * 60 * 1000
const draftLifetime = 10 * 60 * 1000
const maxAnnouncementLength = 3000
const pageSize = 20
const offsetResetMs = 6 * 24 * 60 * 60 * 1000

function taskRecipients(event) {
  const people = (item) => item.assignees ?? (item.assignee ? [item.assignee] : [])
  const recipients = new Set(event.tasks.flatMap(people))
  for (const role of event.roles) {
    for (const task of role.tasks) {
      const direct = people(task)
      for (const assignee of direct.length ? direct : people(role)) recipients.add(assignee)
    }
  }
  recipients.delete('')
  return recipients
}

function hasEventAccess(event, username, isOrganizer) {
  return isOrganizer || Boolean(username && (taskRecipients(event).has(username) || event.roles.some((role) => (
    role.assignees ? role.assignees.includes(username) : role.assignee === username
  ))))
}

function eventKey(id) {
  return createHash('sha256').update(id).digest('base64url').slice(0, 24)
}

function telegramUsername(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_]{1,32}$/.test(value) ? `@${value.toLowerCase()}` : null
}

class TelegramError extends Error {
  constructor(code, retryAfter) {
    super('Telegram Bot API request failed')
    this.code = code
    this.retryAfter = retryAfter
  }
}

export function createTelegram({
  token, dataDir, database = join(dataDir, 'regatta.sqlite'), publicOrigin, listEvents, getEvent,
  verifyAdminPassword = () => false, confirmBrowser = () => false, fetchImpl = fetch, idleMs = 500,
}) {
  const origin = new URL(publicOrigin)
  if (!['https:', 'http:'].includes(origin.protocol)) throw new Error('Некорректный публичный адрес трекера.')
  const api = `https://api.telegram.org/bot${encodeURIComponent(token).replace('%3A', ':')}/`
  const db = new DatabaseSync(database, { timeout: 1000 })
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_contacts (
      user_id TEXT PRIMARY KEY, chat_id TEXT NOT NULL, username TEXT UNIQUE,
      selected_event TEXT, organizer_until INTEGER NOT NULL DEFAULT 0,
      prompt_until INTEGER NOT NULL DEFAULT 0, reachable INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS telegram_state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS telegram_login_attempts (
      bucket TEXT PRIMARY KEY, attempts INTEGER NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS telegram_drafts (
      user_id TEXT PRIMARY KEY, nonce TEXT NOT NULL, event_id TEXT NOT NULL,
      text TEXT NOT NULL, expires INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS telegram_outbox (
      id INTEGER PRIMARY KEY, user_id TEXT NOT NULL, chat_id TEXT NOT NULL,
      event_id TEXT, username TEXT, text TEXT NOT NULL, buttons TEXT,
      created INTEGER NOT NULL, ready INTEGER NOT NULL, attempts INTEGER NOT NULL DEFAULT 0,
      audience TEXT NOT NULL DEFAULT 'participants'
    );
    CREATE INDEX IF NOT EXISTS telegram_outbox_ready ON telegram_outbox (ready, id);
  `)
  if (!db.prepare('PRAGMA table_info(telegram_outbox)').all().some((column) => column.name === 'audience')) {
    db.exec("ALTER TABLE telegram_outbox ADD COLUMN audience TEXT NOT NULL DEFAULT 'participants'")
  }
  const state = db.prepare('SELECT value FROM telegram_state WHERE key = ?')
  const setState = db.prepare('INSERT INTO telegram_state VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value')
  const contact = db.prepare('SELECT * FROM telegram_contacts WHERE user_id = ?')
  const linked = db.prepare('SELECT user_id, chat_id, username FROM telegram_contacts WHERE username = ? AND reachable = 1')
  const organizers = db.prepare('SELECT user_id, chat_id, username FROM telegram_contacts WHERE organizer_until > ? AND reachable = 1')
  const releaseUsername = db.prepare('UPDATE telegram_contacts SET username = NULL WHERE username = ? AND user_id != ?')
  const clearUsername = db.prepare('UPDATE telegram_contacts SET username = NULL WHERE user_id = ? AND chat_id = ? AND username = ?')
  const saveContact = db.prepare(`
    INSERT INTO telegram_contacts (user_id, chat_id, username) VALUES (?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET chat_id = excluded.chat_id, username = excluded.username, reachable = 1
  `)
  const selectEvent = db.prepare('UPDATE telegram_contacts SET selected_event = ? WHERE user_id = ?')
  const savePrompt = db.prepare('UPDATE telegram_contacts SET prompt_until = ? WHERE user_id = ?')
  const saveOrganizer = db.prepare('UPDATE telegram_contacts SET organizer_until = ? WHERE user_id = ?')
  const setUnreachable = db.prepare('UPDATE telegram_contacts SET reachable = 0 WHERE user_id = ? AND chat_id = ?')
  const removeAttempts = db.prepare('DELETE FROM telegram_login_attempts WHERE expires <= ?')
  const readAttempts = db.prepare('SELECT attempts FROM telegram_login_attempts WHERE bucket = ?')
  const clearAttempts = db.prepare('DELETE FROM telegram_login_attempts WHERE bucket = ?')
  const addAttempt = db.prepare(`
    INSERT INTO telegram_login_attempts VALUES (?, 1, ?)
    ON CONFLICT(bucket) DO UPDATE SET attempts = attempts + 1
  `)
  const saveDraft = db.prepare('INSERT OR REPLACE INTO telegram_drafts VALUES (?, ?, ?, ?, ?)')
  const readDraft = db.prepare('SELECT * FROM telegram_drafts WHERE user_id = ? AND nonce = ? AND expires > ?')
  const removeDraft = db.prepare('DELETE FROM telegram_drafts WHERE user_id = ?')
  const queue = db.prepare(`
    INSERT INTO telegram_outbox (user_id, chat_id, event_id, username, text, buttons, created, ready, audience)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `)
  const nextMessage = db.prepare('SELECT * FROM telegram_outbox WHERE ready <= ? ORDER BY ready, id LIMIT 1')
  const dropMessage = db.prepare('DELETE FROM telegram_outbox WHERE id = ?')
  const retryMessage = db.prepare('UPDATE telegram_outbox SET ready = ?, attempts = attempts + 1 WHERE id = ?')
  const controller = new AbortController()
  const { signal } = controller
  let username = state.get('botUsername')?.value ?? ''
  let offset = Number(state.get('offset')?.value ?? 0)
  let latestUpdateAt = Number(state.get('latestUpdateAt')?.value ?? 0)
  let started = false

  function transaction(callback) {
    db.exec('BEGIN IMMEDIATE')
    try {
      const result = callback()
      db.exec('COMMIT')
      return result
    } catch (error) {
      db.exec('ROLLBACK')
      throw error
    }
  }

  async function call(method, body, timeout = 10_000) {
    const response = await fetchImpl(api + method, {
      method: 'POST', redirect: 'error', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)]),
    })
    const data = await response.json().catch(() => ({}))
    if (!response.ok || !data.ok) throw new TelegramError(data.error_code ?? response.status, data.parameters?.retry_after)
    return data.result
  }

  function eventUrl(event, plan = false) {
    return new URL(`/e/${encodeURIComponent(event.id)}${plan ? '?view=plan' : ''}`, origin).href
  }

  function eventButtons(event) {
    return [[{ text: 'Открыть план', url: eventUrl(event, true) }, { text: 'Открыть мероприятие', url: eventUrl(event) }]]
  }

  function push(recipient, text, buttons, event = null, audience = 'participants') {
    const now = Date.now()
    queue.run(recipient.user_id, recipient.chat_id, event?.id ?? null, event ? recipient.username : null,
      text, buttons ? JSON.stringify(buttons) : null, now, now, audience)
  }

  function recipientsFor(event) {
    const recipients = taskRecipients(event)
    return { recipients: recipients.size, contacts: [...recipients].map((person) => linked.get(person)).filter(Boolean) }
  }

  function broadcast(event, text) {
    const { recipients, contacts } = recipientsFor(event)
    for (const recipient of contacts) push(recipient, text, eventButtons(event), event)
    return { queued: contacts.length, recipients }
  }

  function normalizeAnnouncement(value) {
    const text = typeof value === 'string' ? value.trim() : ''
    if (!text || text.length > maxAnnouncementLength) throw new RangeError('Объявление должно содержать от 1 до 3000 символов.')
    return text
  }

  function announce(event, text) {
    const announcement = normalizeAnnouncement(text)
    return transaction(() => broadcast(event, `Объявление · ${event.title}\n\n${announcement}`))
  }

  function currentEvent(user, isOrganizer) {
    if (!user.selected_event) return null
    const event = safeGetEvent(user.selected_event)
    return event && hasEventAccess(event, user.username, isOrganizer) ? event : null
  }

  function availableEvents(user, isOrganizer) {
    return listEvents().filter((event) => hasEventAccess(event, user.username, isOrganizer))
  }

  function showEvents(user, isOrganizer, page = 0) {
    const events = availableEvents(user, isOrganizer)
    if (!events.length) {
      push(user, user.username
        ? 'Пока у вас нет назначенных мероприятий. Уточните назначение у организатора.'
        : 'Добавьте имя пользователя в настройках Telegram и снова отправьте /start.')
      return
    }
    const lastPage = Math.ceil(events.length / pageSize) - 1
    const index = Math.min(page, lastPage)
    const buttons = events.slice(index * pageSize, (index + 1) * pageSize)
      .map((event) => [{ text: event.title, callback_data: `event:${eventKey(event.id)}` }])
    const paging = []
    if (index > 0) paging.push({ text: 'Назад', callback_data: `events:${index - 1}` })
    if (index < lastPage) paging.push({ text: 'Далее', callback_data: `events:${index + 1}` })
    if (paging.length) buttons.push(paging)
    push(user, 'Выберите мероприятие.', buttons)
  }

  function chooseEvent(user, event, isOrganizer) {
    selectEvent.run(event.id, user.user_id)
    const buttons = [...eventButtons(event), [{ text: 'Сменить мероприятие', callback_data: 'events:0' }]]
    push(user, `Выбрано мероприятие «${event.title}».${isOrganizer ? '\nРассылка участникам: /announce текст' : ''}`, buttons)
  }

  function verifyOrganizer(user, password) {
    const now = Date.now()
    savePrompt.run(0, user.user_id)
    removeAttempts.run(now)
    if ((readAttempts.get(user.user_id)?.attempts ?? 0) >= 5 || (readAttempts.get('global')?.attempts ?? 0) >= 20) {
      push(user, 'Слишком много попыток входа. Попробуйте позже.')
      return
    }
    if (!verifyAdminPassword(password)) {
      addAttempt.run(user.user_id, now + attemptWindow)
      addAttempt.run('global', now + attemptWindow)
      push(user, 'Неверный пароль. Для новой попытки отправьте /admin.')
      return
    }
    clearAttempts.run(user.user_id)
    saveOrganizer.run(now + authLifetime, user.user_id)
    push(user, 'Кабинет организатора подключён на 12 часов.')
    showEvents(user, true)
  }

  function previewAnnouncement(user, input) {
    const event = currentEvent(user, true)
    if (!event) return showEvents(user, true)
    let text
    try {
      text = normalizeAnnouncement(input)
    } catch (error) {
      return push(user, `${error.message}\nКоманда: /announce текст`)
    }
    const nonce = randomBytes(12).toString('base64url')
    saveDraft.run(user.user_id, nonce, event.id, text, Date.now() + draftLifetime)
    const { contacts } = recipientsFor(event)
    push(user, `Рассылка · ${event.title}\nПодключено получателей: ${contacts.length}\n\n${text}`, [[
      { text: 'Отправить', callback_data: `send:${nonce}` }, { text: 'Отмена', callback_data: `cancel:${nonce}` },
    ]])
  }

  function handleCallback(user, value, isOrganizer) {
    const [action, key] = value.split(':')
    if (action === 'events' && /^\d{1,8}$/.test(key)) return showEvents(user, isOrganizer, Number(key))
    if (action === 'event') {
      const selected = availableEvents(user, isOrganizer).find((event) => eventKey(event.id) === key)
      if (selected) return chooseEvent(user, selected, isOrganizer)
      return showEvents(user, isOrganizer)
    }
    if ((action !== 'send' && action !== 'cancel') || !isOrganizer || !key) return
    const draft = readDraft.get(user.user_id, key, Date.now())
    if (!draft) return push(user, 'Это объявление уже обработано или срок подтверждения истёк.')
    removeDraft.run(user.user_id)
    if (action === 'cancel') return push(user, 'Рассылка отменена.')
    const event = currentEvent(user, true)
    if (event?.id !== draft.event_id) return push(user, 'Выбрано другое мероприятие. Создайте новое объявление.')
    const { queued } = broadcast(event, `Объявление · ${event.title}\n\n${draft.text}`)
    push(user, queued ? `Объявление поставлено в очередь. Получателей: ${queued}.` : 'У мероприятия пока нет подключённых получателей.')
  }

  function handleMessage(user, message, isOrganizer) {
    if (message.forward_origin) return false
    const input = typeof message.text === 'string' ? message.text : ''
    const command = /^\/([a-z]+)(?:@[a-z0-9_]+)?(?:\s([\s\S]*))?$/i.exec(input)
    if (command?.[1].toLowerCase() === 'admin' && command[2]?.length) {
      verifyOrganizer(user, command[2])
      return true
    }
    if (!command && input && user.prompt_until > Date.now()) {
      verifyOrganizer(user, input)
      return true
    }
    if (command && user.prompt_until) savePrompt.run(0, user.user_id)
    const action = command?.[1].toLowerCase()
    const browserCode = action === 'start' ? command[2]?.match(/^login_([A-Za-z0-9_-]{32})$/)?.[1] : null
    if (browserCode) {
      if (!user.username) push(user, 'Укажите имя пользователя в Telegram и повторите вход с сайта.')
      else if (confirmBrowser(browserCode, { userId: user.user_id, username: user.username })) {
        push(user, 'Вход подтверждён. Вернитесь на страницу «Регламента» в браузере.')
      } else push(user, 'Ссылка устарела. Начните вход заново на сайте.')
      return false
    }
    if (action === 'admin') {
      savePrompt.run(Date.now() + draftLifetime, user.user_id)
      push(user, 'Введите пароль кабинета. Бот постарается удалить сообщение с паролем после проверки.')
    } else if (action === 'logout') {
      saveOrganizer.run(0, user.user_id)
      selectEvent.run(null, user.user_id)
      removeDraft.run(user.user_id)
      push(user, 'Кабинет организатора отключён.')
    } else if (action === 'announce') {
      if (isOrganizer) previewAnnouncement(user, command[2])
      else push(user, 'Рассылки доступны организатору. Для входа отправьте /admin.')
    } else if (action === 'events') {
      showEvents(user, isOrganizer)
    } else if (action === 'start' || action === 'plan' || input) {
      const events = availableEvents(user, isOrganizer)
      const deepLink = action === 'start' ? command[2]?.match(/^event_([A-Za-z0-9_-]+)$/)?.[1] : null
      const selected = (deepLink && events.find((event) => eventKey(event.id) === deepLink)) ||
        currentEvent(user, isOrganizer) || (events.length === 1 && events[0])
      if (selected) chooseEvent(user, selected, isOrganizer)
      else showEvents(user, isOrganizer)
    }
    return false
  }

  function handleUpdate(update) {
    const callback = update.callback_query
    const message = callback?.message ?? update.message
    const from = callback?.from ?? message?.from
    if (message?.chat?.type !== 'private' || from?.is_bot || !Number.isSafeInteger(from?.id) ||
      !Number.isSafeInteger(message.chat.id)) return null
    const id = String(from.id)
    const handle = telegramUsername(from.username)
    if (handle) releaseUsername.run(handle, id)
    saveContact.run(id, String(message.chat.id), handle)
    const user = contact.get(id)
    const isOrganizer = user.organizer_until > Date.now()
    if (callback) {
      if (typeof callback.data === 'string') handleCallback(user, callback.data, isOrganizer)
      return () => call('answerCallbackQuery', { callback_query_id: callback.id })
    }
    if (handleMessage(user, message, isOrganizer) && Number.isSafeInteger(message.message_id)) {
      return () => call('deleteMessage', { chat_id: user.chat_id, message_id: message.message_id })
    }
    return null
  }

  function safeGetEvent(id) {
    try {
      return getEvent(id)
    } catch (error) {
      if (error.status === 404) return null
      throw error
    }
  }

  async function polling() {
    while (!signal.aborted) {
      try {
        const profile = await call('getMe', {})
        if (signal.aborted) return
        if (/^[A-Za-z0-9_]{1,32}$/.test(profile?.username ?? '')) {
          username = profile.username
          setState.run('botUsername', username)
        }
        while (!signal.aborted) {
          // Telegram can restart update IDs at a lower number after a week of inactivity.
          if (offset && Date.now() - latestUpdateAt >= offsetResetMs) offset = 0
          const updates = await call('getUpdates', { offset, timeout: 25, allowed_updates: ['message', 'callback_query'] }, 35_000)
          if (signal.aborted) return
          for (const update of updates) {
            if (signal.aborted) return
            if (!Number.isSafeInteger(update.update_id) || update.update_id < offset) continue
            const receivedAt = Date.now()
            const after = transaction(() => {
              const action = handleUpdate(update)
              setState.run('offset', String(update.update_id + 1))
              setState.run('latestUpdateAt', String(receivedAt))
              return action
            })
            offset = update.update_id + 1
            latestUpdateAt = receivedAt
            if (after) await after().catch(() => {})
          }
          if (!updates.length) await sleep(idleMs, undefined, { signal })
        }
      } catch (error) {
        if (signal.aborted) return
        await sleep(Math.max(1000, (error.retryAfter || 0) * 1000), undefined, { signal }).catch(() => {})
      }
    }
  }

  async function sendQueued() {
    while (!signal.aborted) {
      const job = nextMessage.get(Date.now())
      if (!job) {
        await sleep(idleMs, undefined, { signal }).catch(() => {})
        continue
      }
      if (!canDeliver(job)) {
        dropMessage.run(job.id)
        continue
      }
      try {
        if (job.event_id && job.audience !== 'organizers') {
          const chat = await call('getChat', { chat_id: job.chat_id })
          if (signal.aborted) return
          if (chat?.type !== 'private' || String(chat.id) !== job.chat_id || telegramUsername(chat.username) !== job.username) {
            clearUsername.run(job.user_id, job.chat_id, job.username)
            dropMessage.run(job.id)
            continue
          }
          if (!canDeliver(job)) {
            dropMessage.run(job.id)
            continue
          }
        }
        await call('sendMessage', {
          chat_id: job.chat_id, text: job.text, link_preview_options: { is_disabled: true },
          ...(job.buttons ? { reply_markup: { inline_keyboard: JSON.parse(job.buttons) } } : {}),
        })
        if (signal.aborted) return
        dropMessage.run(job.id)
      } catch (error) {
        if (signal.aborted) return
        if (error.code === 403) setUnreachable.run(job.user_id, job.chat_id)
        const temporary = error.code === 429 || error.code >= 500 || error.code == null
        if (!temporary || Date.now() - job.created >= 86_400_000) {
          dropMessage.run(job.id)
        } else {
          const wait = Math.max(1000 * (error.retryAfter || 0), 1000 * 2 ** Math.min(job.attempts, 8))
          retryMessage.run(Date.now() + wait, job.id)
          if (error.code === 429) await sleep(wait, undefined, { signal }).catch(() => {})
        }
      }
    }
  }

  function canDeliver(job) {
    const user = contact.get(job.user_id)
    if (!user?.reachable || user.chat_id !== job.chat_id) return false
    if (!job.event_id) return true
    if (job.audience === 'organizers') return user.organizer_until > Date.now() && Boolean(safeGetEvent(job.event_id))
    if (user.username !== job.username) return false
    const event = safeGetEvent(job.event_id)
    return Boolean(event && (job.audience === 'workflow' ? hasEventAccess(event, job.username, false) : taskRecipients(event).has(job.username)))
  }

  return {
    start() {
      if (started || signal.aborted) return
      started = true
      void polling()
      void sendQueued()
    },
    close() {
      if (signal.aborted) return
      controller.abort()
      db.close()
    },
    info(event) {
      const { recipients, contacts } = recipientsFor(event)
      const botUrl = username ? `https://t.me/${username}?start=event_${eventKey(event.id)}` : null
      return { botUrl, recipients, connected: contacts.length }
    },
    loginUrl(code) {
      return username ? `https://t.me/${username}?start=login_${code}` : null
    },
    currentActor(actor) {
      const user = contact.get(actor.userId)
      return user?.username === actor.username ? actor : null
    },
    announce,
    notifyPlan(event) {
      transaction(() => broadcast(event, `План изменился · ${event.title}\nАктуальное расписание — по кнопке ниже.`))
    },
    notifyWorkflow(event, { text, handles = [], coordinators = false }) {
      transaction(() => {
        const sent = new Set()
        for (const handle of handles) {
          const recipient = linked.get(handle)
          if (!recipient || sent.has(recipient.user_id)) continue
          sent.add(recipient.user_id)
          push(recipient, `${event.title}\n${text}`, eventButtons(event), event, 'workflow')
        }
        if (coordinators) for (const recipient of organizers.all(Date.now())) {
          if (!sent.has(recipient.user_id)) push(recipient, `${event.title}\n${text}`, eventButtons(event), event, 'organizers')
        }
      })
    },
  }
}
