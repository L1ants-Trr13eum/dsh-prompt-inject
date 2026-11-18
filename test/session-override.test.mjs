import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, isMain, ok, suite } from './harness.mjs'

const { test, run } = suite('session-override')

const home = mkdtempSync(join(tmpdir(), 'prompt-inject-session-'))
const HOST = '127.0.0.1:58511'

const { MAX_CUSTOM_TEXT_CHARS, SESSION_ROUTE, createHandlers, isSessionOnly, ruleSummary } = await import('../lib/host/routes.js')
const { configPath, readConfig, writeConfig } = await import('../lib/host/config-store.js')
const { clearAllOverrides, overrideOf, sessionIdOf, setOverride } = await import('../lib/host/session-store.js')
const { apply } = await import('../lib/host/index.js')

const BASE = 'BASE PERSONA of the session suite.'
const ALL = { presets: 'all', efforts: 'all', permissions: 'all' }
const LIANGSHEN = { presets: ['liangshen'], efforts: 'all', permissions: 'all' }
const logger = { info: () => {}, warn: () => {} }

/** Four rules that separate the condition match from "every enabled rule". */
function mixedRules() {
  writeConfig({
    version: 1,
    enabled: true,
    rules: [
      { id: 'r-1', name: 'always', text: 'ALWAYS', when: ALL },
      { id: 'r-2', name: 'this preset', text: 'PRESET', when: LIANGSHEN },
      { id: 'r-3', name: 'switched off', text: 'OFF', enabled: false, when: ALL },
      { id: 'r-4', name: 'another preset', text: 'OTHER', when: { presets: ['other'], efforts: 'all', permissions: 'all' } },
      { id: 'r-5', name: 'never by condition', text: 'NEVER', when: {} },
    ],
  })
}

function request({ method = 'GET', url = '/', headers = { host: HOST }, body } = {}) {
  const emitter = new EventEmitter()
  emitter.method = method
  emitter.url = url
  emitter.headers = headers
  emitter.destroy = () => {}
  const chunks = body === undefined ? [] : [Buffer.from(body, 'utf8')]
  queueMicrotask(() => {
    for (const chunk of chunks) emitter.emit('data', chunk)
    emitter.emit('end')
  })
  return emitter
}

function response() {
  const res = { status: 0, headers: undefined, body: '', ended: false }
  res.writeHead = (status, headers) => {
    res.status = status
    res.headers = headers
  }
  res.end = chunk => {
    if (typeof chunk === 'string') res.body += chunk
    res.ended = true
  }
  res.payload = () => JSON.parse(res.body)
  return res
}

const handlers = createHandlers({ logger })
const sessionRoute = handlers.session

async function call(route, { method = 'GET', url = '/', headers = { host: HOST }, body } = {}) {
  const res = response()
  await route(request({ method, url, headers, body }), res)
  return res
}

function post(body) {
  return call(sessionRoute, { method: 'POST', url: SESSION_ROUTE, body: JSON.stringify(body) })
}

function fakeContext({ states = {} } = {}) {
  const listeners = []
  const ctx = {
    listeners,
    registered: [],
    logger,
    on: (event, handler) => {
      if (event === 'system-prompt/assemble') listeners.push(handler)
    },
    sessionProjections: { stateOf: (session, key) => states[session?.id]?.[key] },
    webServer: {
      register: options => {
        ctx.registered.push(options)
        return () => {}
      },
    },
  }
  return ctx
}

function boot(options) {
  const ctx = fakeContext(options)
  apply(ctx)
  ok(typeof ctx.listeners[0] === 'function', 'apply must register the assemble listener')
  return ctx
}

async function assemble(ctx, session, personaText = BASE) {
  const assembly = {
    sections: [
      { name: 'deployment:persona', text: personaText },
      { name: 'tools', text: 'TOOLS' },
    ],
  }
  const out = await ctx.listeners[0](assembly, { agent: { session } }, async () => assembly)
  return { assembly, out }
}

/** Mirror of the host interpolator, as in assemble-dry-run.mjs: same grammar, same throws. */
const VARIABLE_NAME = /^[a-z][a-z0-9_]*$/
const GROUP_AT = /^\{\{([^{}]*)\}\}/

function renderSection(section, variables = {}) {
  if (section.interpolate === false) return section.text
  const text = section.text
  let result = ''
  let last = 0
  for (let open = text.indexOf('{{'); open >= 0; open = text.indexOf('{{', last)) {
    const group = GROUP_AT.exec(text.slice(open))
    if (group === null) {
      if (text.indexOf('}}', open + 2) >= 0) throw new Error('malformed prompt variable reference at "' + text.slice(open, open + 16) + '…"')
      result += text.slice(last, open + 2)
      last = open + 2
      continue
    }
    const name = group[0].slice(2, -2)
    if (!VARIABLE_NAME.test(name)) throw new Error('malformed prompt variable reference "' + group[0] + '" in section "' + section.name + '"')
    if (!Object.hasOwn(variables, name)) throw new Error('unknown prompt variable "{{' + name + '}}" in section "' + section.name + '"')
    result += text.slice(last, open) + variables[name]
    last = open + group[0].length
  }
  return result + text.slice(last)
}

test('sessionIdOf reads the three documented shapes and refuses everything else', () => {
  eq(sessionIdOf({ id: 's1' }), 's1')
  eq(sessionIdOf({ sessionId: 's2' }), 's2')
  eq(sessionIdOf({ header: { id: 's3' } }), 's3')
  eq(sessionIdOf({ id: '  s4  ' }), 's4')
  eq(sessionIdOf({ id: '', header: { id: 's5' } }), 's5', 'an empty id falls through')
  eq(sessionIdOf(undefined), undefined)
  eq(sessionIdOf(null), undefined)
  eq(sessionIdOf({}), undefined)
  eq(sessionIdOf({ id: 42 }), undefined)
  const trapped = {
    get id() {
      throw new Error('no id here')
    },
    header: { id: 's6' },
  }
  eq(sessionIdOf(trapped), 's6', 'a throwing getter falls through to the header id')
})

test('GET without a sessionId reports every enabled rule as the default set', async () => {
  mixedRules()
  const res = await call(sessionRoute, { url: SESSION_ROUTE })
  eq(res.status, 200)
  eq(res.payload(), {
    ok: true,
    sessionId: null,
    override: null,
    defaultRuleIds: ['r-1', 'r-2', 'r-4', 'r-5'],
    rules: [
      { id: 'r-1', name: 'always', enabled: true, sessionOnly: false },
      { id: 'r-2', name: 'this preset', enabled: true, sessionOnly: false },
      { id: 'r-3', name: 'switched off', enabled: false, sessionOnly: false },
      { id: 'r-4', name: 'another preset', enabled: true, sessionOnly: false },
      { id: 'r-5', name: 'never by condition', enabled: true, sessionOnly: true },
    ],
  })
})

test('GET with a sessionId reports the exact condition match when the host can resolve the session', async () => {
  mixedRules()
  const live = createHandlers({ logger }, { factsForSession: id => (id === 's-live' ? { presetId: 'liangshen' } : undefined) })
  const matched = await call(live.session, { url: SESSION_ROUTE + '?sessionId=s-live' })
  eq(matched.payload().defaultRuleIds, ['r-1', 'r-2'], 'r-4 belongs to another preset')
  const gone = await call(live.session, { url: SESSION_ROUTE + '?sessionId=s-gone' })
  eq(gone.payload().defaultRuleIds, ['r-1', 'r-2', 'r-4', 'r-5'], 'an unresolved session falls back to every enabled rule')
  eq(gone.payload().sessionId, 's-gone')
})

test('POST stores the override and echoes exactly the body GET returns', async () => {
  clearAllOverrides()
  mixedRules()
  const res = await post({ sessionId: 's-pin', ruleIds: ['r-2', 'r-1'] })
  eq(res.status, 200)
  const body = res.payload()
  eq(body.ok, true)
  eq(body.session.sessionId, 's-pin')
  eq(body.session.override, { ruleIds: ['r-2', 'r-1'] })
  const again = await call(sessionRoute, { url: SESSION_ROUTE + '?sessionId=s-pin' })
  eq(again.payload(), body.session, 'GET must return the POST echo unchanged')
})

test('an override injects a rule no condition can select, and drops the ones that would', async () => {
  clearAllOverrides()
  writeConfig({
    version: 1,
    enabled: true,
    rules: [
      { id: 'r-1', name: 'pinned', text: 'PINNED', when: {} },
      { id: 'r-2', name: 'matches', text: 'MATCHED', when: ALL },
    ],
  })
  const ctx = boot()
  const before = await assemble(ctx, { id: 's-pin' })
  eq(before.out.sections[0].text, BASE + '\n\nMATCHED', 'without an override only the matching rule injects')
  setOverride('s-pin', ['r-1'])
  const after = await assemble(ctx, { id: 's-pin' })
  eq(after.out.sections[0].text, BASE + '\n\nPINNED', 'the override wins over the condition match')
})

test('an override joins its rules in config order, not in the order they were sent', async () => {
  clearAllOverrides()
  writeConfig({
    version: 1,
    enabled: true,
    rules: [
      { id: 'r-1', name: 'one', text: 'ONE', when: {} },
      { id: 'r-2', name: 'two', text: 'TWO', when: {} },
      { id: 'r-3', name: 'three', text: 'THREE', when: {} },
    ],
  })
  const ctx = boot()
  setOverride('s-order', ['r-3', 'r-1'])
  const { out } = await assemble(ctx, { id: 's-order' })
  eq(out.sections[0].text, BASE + '\n\nONE\n\nTHREE')
})

test('an empty override injects nothing, and DELETE puts the conditions back in charge', async () => {
  clearAllOverrides()
  writeConfig({ version: 1, enabled: true, rules: [{ id: 'r-1', name: 'matches', text: 'MATCHED', when: ALL }] })
  const ctx = boot()
  setOverride('s-empty', [])
  const empty = await assemble(ctx, { id: 's-empty' })
  ok(empty.out === empty.assembly, 'an override pinned to nothing appends nothing')
  const res = await call(sessionRoute, { method: 'DELETE', url: SESSION_ROUTE + '?sessionId=s-empty' })
  eq(res.status, 200)
  eq(res.payload(), { ok: true, sessionId: 's-empty' })
  eq(overrideOf('s-empty'), null)
  const back = await assemble(ctx, { id: 's-empty' })
  eq(back.out.sections[0].text, BASE + '\n\nMATCHED', 'the condition match is back in charge')
  const twice = await call(sessionRoute, { method: 'DELETE', url: SESSION_ROUTE + '?sessionId=s-empty' })
  eq(twice.status, 200, 'clearing twice stays harmless')
})

test('an unknown rule id is refused with 400 and writes nothing at all', async () => {
  clearAllOverrides()
  writeConfig({ version: 1, enabled: true, rules: [{ id: 'r-1', name: 'one', text: 'ONE', when: ALL }] })
  const before = readFileSync(configPath(), 'utf8')
  const res = await post({ sessionId: 's-bad', ruleIds: ['r-1', 'r-nope'] })
  eq(res.status, 400)
  eq(res.payload(), { ok: false, error: 'unknown rule id' })
  eq(readFileSync(configPath(), 'utf8'), before, 'the config file must stay byte-identical')
  eq(overrideOf('s-bad'), null, 'no override is stored')
  const withText = await post({ sessionId: 's-bad', ruleIds: ['r-nope'], customText: 'still refused' })
  eq(withText.payload(), { ok: false, error: 'unknown rule id' })
  eq(readConfig().rules.length, 1, 'no session rule was appended')
})

test('customText becomes a session-only rule that no condition can select', async () => {
  clearAllOverrides()
  writeConfig({ version: 1, enabled: true, rules: [{ id: 'r-1', name: 'one', text: 'ONE', when: ALL }] })
  const exact = createHandlers({ logger }, { factsForSession: () => ({ presetId: 'liangshen' }) })
  const res = await call(exact.session, {
    method: 'POST',
    url: SESSION_ROUTE,
    body: JSON.stringify({ sessionId: 's-custom', ruleIds: ['r-1'], customText: '  我的补充 {{user}}  ' }),
  })
  eq(res.status, 200)
  const session = res.payload().session
  eq(session.override.ruleIds[0], 'r-1')
  eq(session.override.ruleIds.length, 2)
  const appended = session.override.ruleIds[1]
  ok(/^r-sess-\d+-[0-9a-z]{4}$/.test(appended), 'id shape: ' + appended)
  const stored = readConfig().rules.find(rule => rule.id === appended)
  eq(stored.when, {}, 'a session rule carries no condition')
  eq(stored.enabled, true)
  eq(stored.text, '  我的补充 {{user}}  ', 'the text is kept verbatim')
  ok(/^会话自定义 \d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(stored.name), 'name shape: ' + stored.name)
  eq(session.defaultRuleIds, ['r-1'], 'a session rule is never part of the condition match')
  eq(session.rules.find(rule => rule.id === appended).sessionOnly, true)
  const ctx = boot()
  const plain = await assemble(ctx, { id: 's-unrelated' })
  eq(plain.out.sections[0].text, BASE + '\n\nONE', 'the session rule never injects on its own')
  const pinned = await assemble(ctx, { id: 's-custom' })
  eq(
    renderSection(pinned.out.sections[0], pinned.out.variables ?? {}),
    BASE + '\n\nONE\n\n  我的补充 {{user}}  ',
    'the override injects it in config order',
  )
})

test('an overridden rule keeps every {{...}} byte-identical through the interpolator', async () => {
  clearAllOverrides()
  const nasty = 'A {{user}} B {{ a.b }} C {{}} D {{ open only E {{pinlb}} F'
  writeConfig({ version: 1, enabled: true, rules: [{ id: 'r-1', name: 'braces', text: nasty, when: {} }] })
  const ctx = boot()
  setOverride('s-braces', ['r-1'])
  const { out } = await assemble(ctx, { id: 's-braces' })
  eq(renderSection(out.sections[0], out.variables ?? {}), BASE + '\n\n' + nasty)
  ok(typeof out.variables?.pinlb === 'string', 'the escape variable is registered on the assembly')
})

test('customText above the cap is refused with 413 and writes nothing', async () => {
  clearAllOverrides()
  writeConfig({ version: 1, enabled: true, rules: [{ id: 'r-1', name: 'one', text: 'ONE', when: ALL }] })
  const before = readFileSync(configPath(), 'utf8')
  const tooBig = await post({ sessionId: 's-big', ruleIds: [], customText: 'x'.repeat(MAX_CUSTOM_TEXT_CHARS + 1) })
  eq(tooBig.status, 413)
  eq(tooBig.payload(), { ok: false, error: 'too large' })
  eq(readFileSync(configPath(), 'utf8'), before, 'the config file must stay byte-identical')
  eq(overrideOf('s-big'), null, 'no override is stored')
  const edge = await post({ sessionId: 's-edge', ruleIds: [], customText: 'y'.repeat(MAX_CUSTOM_TEXT_CHARS) })
  eq(edge.status, 200, 'exactly the cap is accepted')
  eq(readConfig().rules.length, 2)
})

test('the session route keeps the same-origin fence, the 405 shape and the 400 shape', async () => {
  clearAllOverrides()
  const foreign = { host: HOST, origin: 'http://evil.example' }
  const fenced = await call(sessionRoute, { method: 'POST', url: SESSION_ROUTE, headers: foreign, body: JSON.stringify({ sessionId: 's-x', ruleIds: [] }) })
  eq(fenced.status, 403)
  eq(overrideOf('s-x'), null)
  const fencedDelete = await call(sessionRoute, { method: 'DELETE', url: SESSION_ROUTE + '?sessionId=s-x', headers: foreign })
  eq(fencedDelete.status, 403)
  const put = await call(sessionRoute, { method: 'PUT', url: SESSION_ROUTE })
  eq(put.status, 405)
  const readOnlyFence = await call(sessionRoute, { url: SESSION_ROUTE, headers: foreign })
  eq(readOnlyFence.status, 200, 'GET is not fenced')
  eq((await post({ ruleIds: [] })).status, 400, 'a missing sessionId is refused')
  eq((await post({ sessionId: 's-x', ruleIds: 'r-1' })).status, 400, 'ruleIds must be an array')
  eq((await post({ sessionId: 's-x', ruleIds: [''] })).status, 400, 'an empty rule id is refused')
  eq((await call(sessionRoute, { method: 'DELETE', url: SESSION_ROUTE })).status, 400, 'DELETE needs a sessionId')
  const badJson = await call(sessionRoute, { method: 'POST', url: SESSION_ROUTE, body: '{' })
  eq(badJson.status, 400)
  eq(badJson.payload(), { ok: false, error: 'invalid JSON' })
})

test('a long rule name is cut to the cap and flagged, and sessionOnly follows the tri-state', () => {
  eq(ruleSummary({ id: 'r-1', name: 'x'.repeat(200), enabled: true, when: ALL }), {
    id: 'r-1',
    name: 'x'.repeat(120),
    enabled: true,
    sessionOnly: false,
    truncated: true,
  })
  eq(ruleSummary({ id: 'r-2' }), { id: 'r-2', name: '', enabled: true, sessionOnly: true })
  eq(isSessionOnly({}), true)
  eq(isSessionOnly({ presets: 'all', efforts: 'all' }), true, 'an unset dimension keeps the rule out of the match')
  eq(isSessionOnly({ presets: [], efforts: 'all', permissions: 'all' }), true, 'an empty list is not in effect')
  eq(isSessionOnly({ presets: 'all', efforts: 'all', permissions: ['x'] }), false)
})

test('apply registers the config, options and session routes exactly once', () => {
  const ctx = boot()
  eq(ctx.registered.map(options => options.path), ['/api/prompt-inject/config', '/api/prompt-inject/options', SESSION_ROUTE])
  eq(ctx.registered.map(options => options.kind), ['exact', 'exact', 'exact'])
  ok(ctx.registered.every(options => typeof options.handler === 'function'), 'every route carries a handler')
  apply(ctx)
  eq(ctx.registered.length, 3, 'a second apply must not register again')
})

test('an unresolvable session falls back to the condition match and never throws', async () => {
  clearAllOverrides()
  writeConfig({ version: 1, enabled: true, rules: [{ id: 'r-1', name: 'one', text: 'ONE', when: ALL }] })
  const ctx = boot()
  const trapped = {
    get id() {
      throw new Error('no id')
    },
  }
  const out = await ctx.listeners[0]({ sections: [{ name: 'persona', text: 'BASE' }] }, { agent: { session: trapped } }, async () => ({
    sections: [{ name: 'persona', text: 'BASE' }],
  }))
  eq(out.sections[0].text, 'BASE\n\nONE')
})

test('a second pass over an overridden assembly adds nothing', async () => {
  clearAllOverrides()
  writeConfig({ version: 1, enabled: true, rules: [{ id: 'r-1', name: 'one', text: 'ONCE', when: {} }] })
  const ctx = boot()
  setOverride('s-twice', ['r-1'])
  const first = await assemble(ctx, { id: 's-twice' })
  const twice = await ctx.listeners[0](first.out, { agent: { session: { id: 's-twice' } } }, async () => first.out)
  ok(twice === first.out, 'the second pass must return its input object')
  eq(twice.sections[0].text.split('ONCE').length - 1, 1, 'the text appears exactly once')
})

test('a disabled rule and a disabled config still win over the override', async () => {
  clearAllOverrides()
  writeConfig({
    version: 1,
    enabled: true,
    rules: [
      { id: 'r-1', name: 'off', text: 'SWITCHED-OFF', enabled: false, when: {} },
      { id: 'r-2', name: 'on', text: 'SWITCHED-ON', when: {} },
    ],
  })
  const ctx = boot()
  setOverride('s-off', ['r-1', 'r-2'])
  eq((await assemble(ctx, { id: 's-off' })).out.sections[0].text, BASE + '\n\nSWITCHED-ON')
  writeConfig({ version: 1, enabled: false, rules: [{ id: 'r-2', name: 'on', text: 'SWITCHED-ON', when: {} }] })
  const killed = await assemble(ctx, { id: 's-off' })
  ok(killed.out === killed.assembly, 'the global switch still stops every injection')
})

test('the id the assembly resolves is the id the HTTP route stored', async () => {
  clearAllOverrides()
  writeConfig({ version: 1, enabled: true, rules: [{ id: 'r-1', name: 'one', text: 'PINNED', when: {} }] })
  const ctx = boot()
  eq((await post({ sessionId: 's-header', ruleIds: ['r-1'] })).status, 200)
  const { out } = await assemble(ctx, { header: { id: 's-header' } })
  eq(out.sections[0].text, BASE + '\n\nPINNED', 'an id only present on the header must still hit the override')
})

export async function main() {
  process.env.DSH_HOME = home
  clearAllOverrides()
  await run()
}

if (isMain(import.meta.url)) await main()
