import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { test } from 'node:test'
import { createTelegram } from './telegram.mjs'

const assigned = (...assignees) => ({ assignees })
const events = [
  { id: 'meeting', title: 'Регата', roles: [{ ...assigned('@inherited', '@second'), tasks: [assigned(), assigned('@direct')] }], tasks: [assigned('@direct', '@common')] },
  { id: 'next', title: 'Фестиваль', roles: [], tasks: [assigned('@direct')] },
  { id: 'foreign', title: 'Закрытая встреча', roles: [{ ...assigned('@unused'), tasks: [assigned('@elsewhere')] }], tasks: [] },
]

async function fixture(t, { catalog = events, telegramCoordinatorId } = {}) {
  const dataDir = await mkdtemp(join(tmpdir(), 'reglament-telegram-'))
  const updates = []
  const sent = []
  const deleted = []
  const profiles = new Map()
  let updateId = 1
  let bot
  let throttle
  let throttled = 0
  const fetchImpl = async (url, { body, signal }) => {
    const method = new URL(url).pathname.split('/').at(-1)
    const input = JSON.parse(body)
    if (method === 'getMe') return Response.json({ ok: true, result: { username: 'fixture_reglament_bot' } })
    if (method === 'getUpdates') {
      await sleep(5, undefined, { signal })
      return Response.json({ ok: true, result: updates.filter((entry) => entry.update_id >= input.offset) })
    }
    if (method === 'answerCallbackQuery') return Response.json({ ok: true, result: true })
    if (method === 'getChat') return Response.json({ ok: true, result: profiles.get(Number(input.chat_id)) })
    if (method === 'deleteMessage') {
      deleted.push(input)
      return Response.json({ ok: true, result: true })
    }
    assert.equal(method, 'sendMessage')
    if (throttle && input.text.includes(throttle)) {
      throttle = null
      throttled++
      return Response.json({ ok: false, error_code: 429, parameters: { retry_after: 1 } }, { status: 429 })
    }
    sent.push(input)
    return Response.json({ ok: true, result: { message_id: sent.length } })
  }
  const until = async (check) => {
    for (let attempt = 0; attempt < 400; attempt++) {
      const result = check()
      if (result) return result
      await sleep(10)
    }
    assert.fail(`Timed out. Messages: ${JSON.stringify(sent)}`)
  }
  function start() {
    bot = createTelegram({ token: 'mock-token', dataDir, publicOrigin: 'https://fixture.invalid', listEvents: () => catalog, getEvent: (id) => catalog.find((event) => event.id === id), verifyAdminPassword: (value) => value === 'fixture-admin-secret', fetchImpl, idleMs: 5, telegramCoordinatorId })
    bot.start()
    return bot
  }
  t.after(async () => {
    bot?.close()
    await rm(dataDir, { recursive: true, force: true })
  })
  function message(id, username, text, type = 'private') {
    if (type === 'private') profiles.set(id, { id, username, type })
    updates.push({ update_id: updateId, message: { message_id: updateId++, chat: { id, type }, from: { id, username }, text } })
  }
  function callback(id, username, data) {
    profiles.set(id, { id, username, type: 'private' })
    updates.push({ update_id: updateId, callback_query: { id: String(updateId++), from: { id, username }, message: { chat: { id, type: 'private' } }, data } })
  }
  const replies = (id, fragment) => sent.filter((entry) => Number(entry.chat_id) === id && entry.text.includes(fragment))
  return { start, message, callback, replies, until, sent, deleted, profiles, throttle: (needle) => { throttle = needle }, throttled: () => throttled }
}

test('private participants switch assigned events and receive scoped plan and announcements', { timeout: 10_000 }, async (t) => {
  const qa = await fixture(t)
  let bot = qa.start()
  const link = await qa.until(() => bot.info(events[0]).botUrl)
  assert.equal(new URL(link).hostname, 't.me')
  assert.deepEqual(bot.info(events[0]), { botUrl: link, recipients: 4, connected: 0 })
  qa.message(10, 'Direct', '/events')
  qa.message(20, 'Inherited', `/start ${new URL(link).searchParams.get('start')}`)
  qa.message(30, 'Unused', '/start')
  qa.message(40, 'Common', '/start', 'group')
  const listing = await qa.until(() => qa.replies(10, 'Выберите мероприятие').at(-1))
  const buttons = listing.reply_markup.inline_keyboard.flat()
  assert.deepEqual(buttons.map((button) => button.text), ['Регата', 'Фестиваль'])
  qa.callback(10, 'Direct', buttons[1].callback_data)
  const picked = await qa.until(() => qa.replies(10, 'Фестиваль').at(-1))
  assert.ok(picked.reply_markup.inline_keyboard.flat().some((button) => button.url === 'https://fixture.invalid/e/next?view=plan'))
  await qa.until(() => qa.replies(20, 'Регата').at(-1))
  assert.equal(bot.info(events[0]).connected, 2)
  await qa.until(() => bot.info(events[2]).connected === 1)
  assert.equal(qa.replies(40, '').length, 0)

  assert.deepEqual(bot.announce(events[0], 'Общий сбор'), { queued: 2, recipients: 4 })
  bot.notifyPlan(events[0])
  for (const id of [10, 20]) {
    await qa.until(() => qa.replies(id, 'Общий сбор').length === 1)
    const plan = await qa.until(() => qa.replies(id, 'План изменился').at(-1))
    assert.ok(plan.reply_markup.inline_keyboard.flat().some((button) => button.url === 'https://fixture.invalid/e/meeting?view=plan'))
  }
  assert.equal(qa.replies(30, 'Общий сбор').length, 0)
  bot.close()
  bot = qa.start()
  assert.equal(bot.info(events[0]).connected, 2)
  qa.message(10, 'Direct', '/start')
  await qa.until(() => qa.replies(10, 'Фестиваль').length === 2)
})

test('announcements and automatic plan notices reach all linked role and direct task assignees', { timeout: 10_000 }, async (t) => {
  const event = { id: 'roster', title: 'Регата', roles: [
    { ...assigned('@without_tasks'), tasks: [] },
    { ...assigned('@overridden'), tasks: [assigned('@direct', '@common')] },
    { assignee: '@legacy', tasks: [] },
  ], tasks: [assigned('@common')] }
  const later = { id: 'later', title: 'Фестиваль', roles: [], tasks: [assigned('@without_tasks')] }
  const qa = await fixture(t, { catalog: [event, later] })
  const bot = qa.start()
  const laterLink = await qa.until(() => bot.info(later).botUrl)
  qa.message(10, 'without_tasks', `/start ${new URL(laterLink).searchParams.get('start')}`)
  qa.message(20, 'overridden', '/start')
  qa.message(30, 'direct', '/start')
  qa.message(40, 'common', '/start')
  qa.message(50, 'legacy', '/start')
  qa.message(60, 'unassigned', '/start')
  await qa.until(() => qa.replies(10, '«Фестиваль»').length)
  await qa.until(() => qa.replies(60, 'Пока у вас нет назначенных мероприятий').length)
  assert.deepEqual(bot.info(event), { botUrl: bot.info(event).botUrl, recipients: 5, connected: 5 })
  assert.deepEqual(bot.announce(event, 'Объявление для всей команды'), { queued: 5, recipients: 5 })
  bot.notifyPlan(event)
  for (const id of [10, 20, 30, 40, 50]) {
    await qa.until(() => qa.replies(id, 'Объявление для всей команды').length === 1)
    await qa.until(() => qa.replies(id, 'План изменился').length === 1)
  }
  assert.equal(qa.replies(60, 'Объявление для всей команды').length, 0)
  assert.equal(qa.replies(60, 'План изменился').length, 0)
})

test('the configured Telegram coordinator keeps verified access when changing username', { timeout: 10_000 }, async (t) => {
  const qa = await fixture(t, { telegramCoordinatorId: '50' })
  const bot = qa.start()
  qa.message(50, 'before', '/start')
  await qa.until(() => qa.replies(50, 'Команды организатора').length === 1)
  const actor = { userId: '50', username: '@before' }
  assert.deepEqual(bot.currentActor(actor), actor)

  qa.message(50, 'after', '/start')
  await qa.until(() => qa.replies(50, 'Команды организатора').length === 2)
  assert.deepEqual(bot.currentActor(actor), { userId: '50', username: '@after' })
  qa.message(60, 'before', '/help')
  await qa.until(() => qa.replies(60, 'Команды участника').length)
  assert.equal(qa.replies(60, 'Команды организатора').length, 0)
  assert.deepEqual(bot.currentActor(actor), { userId: '50', username: '@after' })
})

test('Telegram organizer password verifies by user ID and broadcasts only after confirmation', { timeout: 10_000 }, async (t) => {
  const qa = await fixture(t)
  const bot = qa.start()
  await qa.until(() => bot.info(events[0]).botUrl)
  qa.message(10, 'direct', '/events')
  qa.message(50, 'organizer', '/admin')
  await qa.until(() => qa.replies(50, 'пароль').length)
  qa.message(50, 'organizer', 'fixture-admin-secret')
  await qa.until(() => qa.replies(50, 'Кабинет организатора подключён').length)
  assert.ok(qa.deleted.some((message) => Number(message.chat_id) === 50))
  assert.ok(qa.sent.every((message) => !message.text.includes('fixture-admin-secret')))
  const list = await qa.until(() => qa.replies(50, 'Выберите мероприятие').at(-1))
  const meeting = list.reply_markup.inline_keyboard.flat().find((button) => button.text === 'Регата')
  assert.ok(list.reply_markup.inline_keyboard.flat().some((button) => button.text === 'Закрытая встреча'))
  qa.callback(50, 'changed_name', meeting.callback_data)
  await qa.until(() => qa.replies(50, 'Выбрано мероприятие').length)
  qa.message(10, 'direct', '/announce Запрещённый текст')
  qa.message(50, 'changed_name', '/announce Объявление из бота')
  const preview = await qa.until(() => qa.replies(50, 'Объявление из бота').at(-1))
  assert.match(preview.text, /Подключено получателей: 1 из 4/)
  assert.match(preview.text, /\/start.*назначенн/)
  const confirm = preview.reply_markup.inline_keyboard.flat().find((button) => button.text === 'Отправить')
  assert.equal(qa.replies(10, 'Объявление из бота').length, 0)
  assert.ok(confirm)
  qa.callback(50, 'changed_name', confirm.callback_data)
  qa.callback(50, 'changed_name', confirm.callback_data)
  await qa.until(() => qa.replies(10, 'Объявление из бота').length === 1)
  assert.equal(qa.replies(50, 'Запрещённый текст').length, 0)
  qa.message(50, 'changed_name', '/logout')
  await qa.until(() => qa.replies(50, 'Кабинет организатора отключён').length)
})

test('Telegram password attempts stay limited after restart', { timeout: 10_000 }, async (t) => {
  const qa = await fixture(t)
  let bot = qa.start()
  for (let attempt = 0; attempt < 5; attempt++) qa.message(50, 'organizer', '/admin wrong')
  await qa.until(() => qa.replies(50, 'Неверный пароль').length === 5)
  bot.close()
  bot = qa.start()
  qa.message(50, 'organizer', '/admin fixture-admin-secret')
  await qa.until(() => qa.replies(50, 'Слишком много попыток').length)
  assert.equal(qa.replies(50, 'Кабинет организатора подключён').length, 0)
  assert.ok(qa.sent.every((message) => !message.text.includes('fixture-admin-secret')))
})

test('organizer start includes commands and preserves event selection; participant help stays scoped', { timeout: 10_000 }, async (t) => {
  const qa = await fixture(t)
  const bot = qa.start()
  const eventLink = await qa.until(() => bot.info(events[0]).botUrl)
  qa.message(50, 'organizer', '/admin fixture-admin-secret')
  await qa.until(() => qa.replies(50, 'Выберите мероприятие').length)
  qa.message(50, 'organizer', '/start')
  const menu = await qa.until(() => qa.replies(50, 'Команды организатора').at(-1))
  assert.ok(menu.text.includes('Выберите мероприятие'))
  assert.ok(menu.reply_markup.inline_keyboard.flat().some((button) => button.text === 'Регата'))
  for (const command of ['/start', '/events', '/plan', '/announce текст', '/admin', '/logout', '/help']) {
    assert.ok(menu.text.includes(command), command)
  }
  qa.message(50, 'organizer', `/start ${new URL(eventLink).searchParams.get('start')}`)
  const selected = await qa.until(() => qa.replies(50, 'Команды организатора').find((message) => message.text.includes('«Регата»')))
  assert.ok(selected.reply_markup.inline_keyboard.flat().some((button) => button.url?.endsWith('/meeting?view=plan')))
  qa.message(50, 'organizer', '/start')
  await qa.until(() => qa.replies(50, 'Команды организатора').filter((message) => message.text.includes('«Регата»')).length === 2)
  qa.message(50, 'organizer', `/start login_${'a'.repeat(32)}`)
  await qa.until(() => qa.replies(50, 'Ссылка устарела').length)
  assert.equal(qa.replies(50, 'Команды организатора').length, 3)

  qa.message(10, 'direct', '/start')
  await qa.until(() => qa.replies(10, 'Выберите мероприятие').length)
  qa.message(10, 'direct', '/help')
  const participant = await qa.until(() => qa.replies(10, 'Команды участника').at(-1))
  assert.ok(participant.text.includes('/plan'))
  assert.doesNotMatch(participant.text, /\/(announce|admin|logout)\b/)
  assert.equal(qa.replies(10, 'Команды организатора').length, 0)
})

test('outbox survives restart and retries Telegram rate limits', { timeout: 10_000 }, async (t) => {
  const qa = await fixture(t)
  let bot = qa.start()
  qa.message(10, 'direct', '/events')
  await qa.until(() => qa.replies(10, 'Выберите мероприятие').length)
  qa.throttle('После рестарта')
  assert.deepEqual(bot.announce(events[0], 'После рестарта'), { queued: 1, recipients: 4 })
  await qa.until(() => qa.throttled())
  bot.close()
  bot = qa.start()
  await qa.until(() => qa.replies(10, 'После рестарта').length === 1)
  assert.equal(bot.info(events[0]).connected, 1)
})

test('an event announcement never goes to a private chat whose current Telegram identity no longer matches', { timeout: 10_000 }, async (t) => {
  const qa = await fixture(t)
  const bot = qa.start()
  qa.message(10, 'direct', '/events')
  qa.message(20, 'inherited', '/events')
  qa.message(30, 'second', '/events')
  qa.message(40, 'common', '/events')
  await qa.until(() => bot.info(events[0]).connected === 4)
  qa.profiles.set(10, { id: 10, type: 'private', username: 'new_handle' })
  qa.profiles.set(20, { id: 20, type: 'private' })
  qa.profiles.set(30, { id: 31, type: 'private', username: 'second' })
  assert.deepEqual(bot.announce(events[0], 'Только назначенным участникам'), { queued: 4, recipients: 4 })
  await qa.until(() => qa.replies(40, 'Только назначенным участникам').length === 1)
  assert.equal(qa.replies(10, 'Только назначенным участникам').length, 0)
  assert.equal(qa.replies(20, 'Только назначенным участникам').length, 0)
  assert.equal(qa.replies(30, 'Только назначенным участникам').length, 0)
  assert.equal(bot.info(events[0]).connected, 1)
})
