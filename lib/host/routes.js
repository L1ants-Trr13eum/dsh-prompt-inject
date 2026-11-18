/**
 * HTTP surface of dsh-prompt-inject: the settings card's config, its option
 * candidates, and the per-session injection override. Same-origin fence, 256KB
 * body cap, JSON in and JSON out.
 * @module dsh-prompt-inject/host/routes
 */
import { randomBytes } from 'node:crypto'
import { DIMENSIONS, appendRule, normalizeConfig, readConfig, writeConfig } from './config-store.js'
import { matches } from './match.js'
import { clearOverride, overrideOf, setOverride } from './session-store.js'

/** Prefix shared with the browser half. */
export const API_PREFIX = '/api/prompt-inject'

/** GET reads the config, POST replaces it. */
export const CONFIG_ROUTE = API_PREFIX + '/config'

/** GET lists the candidate values for the three match dimensions. */
export const OPTIONS_ROUTE = API_PREFIX + '/options'

/** GET reads, POST replaces and DELETE clears one session's override. */
export const SESSION_ROUTE = API_PREFIX + '/session'

/** Largest accepted POST body. */
export const MAX_BODY_BYTES = 256 * 1024

/** Longest accepted `customText`, in characters. */
export const MAX_CUSTOM_TEXT_CHARS = 20000

/** Longest rule name echoed back by GET; a longer name is cut and flagged. */
export const MAX_RULE_NAME_CHARS = 120

/** Web servers this module already registered every route on. */
const registered = new WeakSet()

function messageOf(error) {
  if (error === null || error === undefined) return 'unknown error'
  return error.message === undefined ? String(error) : String(error.message)
}

function attempt(run) {
  try {
    return run()
  } catch {
    return undefined
  }
}

function logLine(ctx, level, line) {
  try {
    ctx?.logger?.[level]?.('dsh-prompt-inject: ' + line)
  } catch {
    /* logging must never break a request */
  }
}

function send(response, status, payload) {
  response.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json; charset=utf-8' })
  response.end(JSON.stringify(payload))
}

/** @returns whether the request came from this origin; a missing Origin header counts as same-origin. */
export function isSameOrigin(request) {
  const origin = request?.headers?.origin
  if (origin === undefined) return true
  const host = request?.headers?.host
  if (host === undefined) return false
  return attempt(() => new URL(origin).host === host) === true
}

/** @returns the request body as UTF-8 text; rejects with status 413 above the cap. */
export function readBody(request, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    request.on('data', chunk => {
      size += chunk.length
      if (size > limit) {
        reject(Object.assign(new Error('body exceeds ' + limit + ' bytes'), { status: 413 }))
        attempt(() => request.destroy())
        return
      }
      chunks.push(chunk)
    })
    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    request.on('error', reject)
  })
}

/** Official Chinese labels for the built-in presets (a built-in row has no name). */
const PRESET_LABELS = { standard: '标准模式', ptc: 'PTC 模式', minimal: '极简模式', cordis: '创造模式' }

/** Official Chinese labels for the permission presets. */
const PERMISSION_LABELS = {
  'read-only': '仅可查看',
  'workspace-write': '工作区内修改',
  'danger-full-access': '完全权限',
  auto: '自动审查',
}

/** Official Chinese labels for the reasoning efforts, including the ones only a live model advertises. */
const EFFORT_LABELS = { off: '关闭', low: '低', medium: '中', high: '高', max: '最高' }

/** The efforts offered while no live model answers: the three this host used to hard-code. */
const EFFORT_BASELINE = ['low', 'medium', 'high']

/** How long one successful live lookup is reused, in milliseconds. */
const EFFORT_CACHE_TTL_MS = 120000

/** Hard deadline of one live lookup, so a slow adapter never holds an HTTP handler open. */
const EFFORT_LOOKUP_TIMEOUT_MS = 8000

/** Memoized result of the last successful live lookup; a fallback never lands here. */
let effortCache = { at: 0, options: undefined }

/** Drop the memoized lookup, so the next read of the candidates asks the runtime again. */
export function clearEffortCache() {
  effortCache = { at: 0, options: undefined }
}

function textOf(value) {
  return typeof value === 'string' ? value.trim() : ''
}

/** @returns one candidate; an empty label reads as the id, so a label is always a string. */
function optionOf(id, label) {
  const text = textOf(label)
  return { id, label: text === '' ? id : text }
}

/** @returns a whole static label table as candidates, in table order. */
function staticOptions(table) {
  return Object.keys(table).map(id => optionOf(id, table[id]))
}

/** Append one candidate, keeping first-seen order; an empty or repeated id is ignored. */
function addOption(list, entry) {
  if (entry.id === '' || list.some(item => item.id === entry.id)) return
  list.push(entry)
}

/**
 * Rows of the injected agent-preset registry. Its `list()` is async, so a
 * synchronous read returns a pending Promise rather than the rows.
 * @returns `[{ id, label }]`; an empty or failing registry falls back to the four built-ins.
 */
async function presetOptions(ctx) {
  const list = []
  try {
    const service = ctx?.agentPresets ?? ctx?.get?.('agentPresets')
    const rows = typeof service?.list === 'function' ? await service.list() : undefined
    for (const row of Array.isArray(rows) ? rows : []) {
      const id = textOf(attempt(() => row?.id))
      if (id === '') continue
      const name = textOf(attempt(() => row?.name))
      addOption(list, optionOf(id, name === '' ? PRESET_LABELS[id] : name))
    }
  } catch {
    /* a registry that refuses to list the presets falls through to the static table */
  }
  return list.length > 0 ? list : staticOptions(PRESET_LABELS)
}

/**
 * Options of the permission-preset catalog, which is synchronous.
 * @returns `[{ id, label }]`; a missing or failing catalog falls back to the four built-ins.
 */
function permissionOptions(ctx) {
  const list = []
  const service = attempt(() => ctx?.permissionPresets ?? ctx?.get?.('permissionPresets'))
  const catalog = attempt(() => service?.catalog?.())
  const rows = attempt(() => catalog?.options)
  for (const row of Array.isArray(rows) ? rows : []) {
    const id = textOf(attempt(() => row?.value)) || textOf(attempt(() => row?.id))
    if (id === '') continue
    const name = textOf(attempt(() => row?.name))
    addOption(list, optionOf(id, PERMISSION_LABELS[id] ?? (name !== '' && name !== id ? name : id)))
  }
  return list.length > 0 ? list : staticOptions(PERMISSION_LABELS)
}

/** Run one lookup against a hard deadline, so a slow adapter cannot hold the request open. */
async function withDeadline(run, ms) {
  let timer
  try {
    return await Promise.race([
      Promise.resolve().then(run),
      new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('timed out after ' + ms + 'ms')), ms)
        if (typeof timer?.unref === 'function') timer.unref()
      }),
    ])
  } finally {
    if (timer !== undefined) clearTimeout(timer)
  }
}

/**
 * Every reasoning effort the live model registry advertises, over its providers and
 * models. A provider or model that fails is skipped rather than sinking the rest.
 * @returns `[{ id, label }]` in first-seen order; an unreadable provider list reads as empty.
 */
async function advertisedEfforts(llm) {
  const providers = await attempt(() => llm.listProviders())
  const list = []
  for (const provider of Array.isArray(providers) ? providers : []) {
    const providerId = textOf(attempt(() => provider?.id)) || textOf(provider)
    if (providerId === '') continue
    let models
    try {
      models = await llm.listModels(providerId)
    } catch {
      continue
    }
    for (const model of Array.isArray(models) ? models : []) {
      const modelId = textOf(attempt(() => model?.id)) || textOf(model)
      if (modelId === '') continue
      let resolved
      try {
        resolved = await llm.resolveModelInfo(providerId, modelId)
      } catch {
        continue
      }
      const efforts = attempt(() => resolved?.reasoning?.efforts)
      for (const effort of Array.isArray(efforts) ? efforts : []) {
        const id = textOf(attempt(() => effort?.id)) || textOf(effort)
        if (id === '') continue
        addOption(list, optionOf(id, EFFORT_LABELS[id] ?? attempt(() => effort?.name)))
      }
    }
  }
  return list
}

/**
 * The efforts the host's model registry advertises, read lazily through
 * `ctx.get('llm')` so this row needs no `inject: ['llm']`, and memoized for
 * {@link EFFORT_CACHE_TTL_MS}. Only a complete answer is cached: a timeout, an
 * unreadable service or an empty catalog reads as undefined and is retried next time.
 * @returns `[{ id, label }]`, or undefined when nothing answered.
 */
async function liveEffortOptions(ctx) {
  if (effortCache.options !== undefined && Date.now() - effortCache.at < EFFORT_CACHE_TTL_MS) {
    return effortCache.options
  }
  const llm = attempt(() => (typeof ctx?.get === 'function' ? ctx.get('llm') : ctx?.llm))
  if (llm === null || typeof llm !== 'object') return undefined
  if (typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function' || typeof llm.resolveModelInfo !== 'function') {
    return undefined
  }
  let list
  try {
    list = await withDeadline(() => advertisedEfforts(llm), EFFORT_LOOKUP_TIMEOUT_MS)
  } catch {
    return undefined
  }
  if (!Array.isArray(list) || list.length === 0) return undefined
  effortCache = { at: Date.now(), options: list }
  return list
}

/**
 * The reasoning effort candidates: what the live model registry advertises, else the
 * three this host used to hard-code, plus every effort the stored rules already use.
 * @returns `[{ id, label }]` in first-seen order; a label is always a string.
 */
async function effortOptions(ctx) {
  const live = await liveEffortOptions(ctx)
  const list = []
  for (const entry of live ?? []) addOption(list, entry)
  if (live === undefined) {
    for (const id of EFFORT_BASELINE) addOption(list, optionOf(id, EFFORT_LABELS[id]))
  }
  const config = attempt(() => readConfig())
  for (const rule of Array.isArray(config?.rules) ? config.rules : []) {
    const value = attempt(() => rule?.when?.efforts)
    for (const entry of Array.isArray(value) ? value : []) {
      const id = textOf(entry)
      if (id !== '') addOption(list, optionOf(id, EFFORT_LABELS[id]))
    }
  }
  return list
}

/**
 * Collect the candidates the settings card offers: ids with the label to show,
 * de-duplicated, in the order the source (or the static table) gives them.
 * @returns `{ presets, permissions, efforts }`
 */
export async function collectOptions(ctx) {
  return {
    presets: await presetOptions(ctx),
    permissions: permissionOptions(ctx),
    efforts: await effortOptions(ctx),
  }
}

async function handleConfig(ctx, request, response) {
  const method = request?.method ?? 'GET'
  if (method === 'GET') {
    try {
      send(response, 200, { ok: true, config: readConfig() })
    } catch (error) {
      send(response, 500, { ok: false, error: messageOf(error) })
    }
    return
  }
  if (method !== 'POST') {
    send(response, 405, { ok: false, error: 'method ' + method + ' is not allowed' })
    return
  }
  if (!isSameOrigin(request)) {
    logLine(ctx, 'warn', 'cross-origin config write refused')
    send(response, 403, { ok: false, error: 'cross-origin config write refused' })
    return
  }
  let text
  try {
    text = await readBody(request)
  } catch (error) {
    send(response, error?.status ?? 400, { ok: false, error: messageOf(error) })
    return
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    send(response, 400, { ok: false, error: 'invalid JSON' })
    return
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    send(response, 400, { ok: false, error: 'expected an object of the shape { config }' })
    return
  }
  const normalized = normalizeConfig(payload.config)
  if (!normalized.ok) {
    send(response, 400, { ok: false, error: normalized.error, errors: normalized.errors })
    return
  }
  try {
    const config = writeConfig(normalized.config)
    logLine(ctx, 'info', 'config saved with ' + config.rules.length + ' rule(s)')
    send(response, 200, { ok: true, config })
  } catch (error) {
    send(response, 500, { ok: false, error: messageOf(error) })
  }
}

async function handleOptions(ctx, request, response) {
  const method = request?.method ?? 'GET'
  if (method !== 'GET') {
    send(response, 405, { ok: false, error: 'method ' + method + ' is not allowed' })
    return
  }
  try {
    send(response, 200, { ok: true, ...(await collectOptions(ctx)) })
  } catch (error) {
    send(response, 500, { ok: false, error: messageOf(error) })
  }
}

/** @returns the query of a request; a missing url reads as an empty query. */
function queryOf(request) {
  const target = attempt(() => request?.url)
  if (typeof target !== 'string' || target === '') return new URLSearchParams()
  return attempt(() => new URL(target, 'http://localhost').searchParams) ?? new URLSearchParams()
}

/** @returns the `sessionId` query parameter, trimmed, or undefined when it is absent. */
export function sessionIdFromQuery(request) {
  const value = attempt(() => queryOf(request).get('sessionId'))
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/** @returns whether a condition spec can ever select a rule: "all", or a non-empty list. */
function inEffect(spec) {
  return spec === 'all' || (Array.isArray(spec) && spec.length > 0)
}

/**
 * A rule no condition can select, because at least one dimension is not in
 * effect. `when: {}` is the usual case: only a session override injects such a rule.
 * @returns whether the rule is reachable through an override alone.
 */
export function isSessionOnly(when) {
  const spec = when !== null && typeof when === 'object' && !Array.isArray(when) ? when : {}
  return !DIMENSIONS.every(dimension => inEffect(spec[dimension]))
}

/**
 * The card-sized view of one rule: no text, a capped name, and whether a
 * condition can select it at all.
 * @returns `{ id, name, enabled, sessionOnly }`, plus `truncated` when the name was cut.
 */
export function ruleSummary(rule) {
  const raw = typeof rule?.name === 'string' ? rule.name : ''
  const name = raw.length > MAX_RULE_NAME_CHARS ? raw.slice(0, MAX_RULE_NAME_CHARS) : raw
  const summary = { id: rule?.id, name, enabled: rule?.enabled !== false, sessionOnly: isSessionOnly(rule?.when) }
  if (name !== raw) summary.truncated = true
  return summary
}

/**
 * The rule ids a session receives without an override.
 * @param facts - the session's match facts; without them every enabled rule counts.
 * @returns the ids, in config order.
 */
export function defaultRuleIds(config, facts) {
  const rules = Array.isArray(config?.rules) ? config.rules : []
  return rules
    .filter(rule => (facts === undefined ? rule?.enabled !== false : matches(rule, facts)))
    .map(rule => rule?.id)
}

/**
 * The GET body, and the echo POST returns.
 * @param facts - resolved session facts, or undefined to fall back to "every enabled rule".
 */
export function sessionPayload(config, sessionId, facts) {
  const rules = Array.isArray(config?.rules) ? config.rules : []
  return {
    ok: true,
    sessionId: sessionId ?? null,
    override: sessionId === undefined ? null : overrideOf(sessionId),
    defaultRuleIds: defaultRuleIds(config, facts),
    rules: rules.map(ruleSummary),
  }
}

/** Characters the random suffix of a session rule id draws from. */
const ID_ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyz'

function randomSuffix() {
  const bytes = attempt(() => randomBytes(4)) ?? []
  let suffix = ''
  for (let index = 0; index < 4; index += 1) {
    const byte = typeof bytes[index] === 'number' ? bytes[index] : Math.floor(Math.random() * 256)
    suffix += ID_ALPHABET[byte % ID_ALPHABET.length]
  }
  return suffix
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** @returns the `YYYY-MM-DD HH:MM` label a session rule carries. */
export function sessionRuleName(now = new Date()) {
  const date = now.getFullYear() + '-' + pad2(now.getMonth() + 1) + '-' + pad2(now.getDate())
  return '会话自定义 ' + date + ' ' + pad2(now.getHours()) + ':' + pad2(now.getMinutes())
}

/**
 * Build the rule a session's `customText` becomes. `when: {}` leaves every
 * dimension out of effect, so no condition can select it: only the override
 * naming its id injects it.
 * @returns the rule to append, with an id no other rule uses.
 */
export function customRule(config, text, now = new Date()) {
  const taken = new Set((Array.isArray(config?.rules) ? config.rules : []).map(rule => rule?.id))
  const prefix = 'r-sess-' + now.getTime()
  let id = prefix + '-' + randomSuffix()
  while (taken.has(id)) id = prefix + '-' + randomSuffix()
  return { id, name: sessionRuleName(now), enabled: true, text, when: {} }
}

/** @returns the facts the hook resolves for this session, or undefined when it cannot. */
function factsOf(hooks, sessionId) {
  if (sessionId === undefined || typeof hooks?.factsForSession !== 'function') return undefined
  const facts = attempt(() => hooks.factsForSession(sessionId))
  return facts !== null && typeof facts === 'object' ? facts : undefined
}

async function handleSession(ctx, request, response, hooks) {
  const method = request?.method ?? 'GET'
  if (method === 'GET') {
    try {
      const sessionId = sessionIdFromQuery(request)
      send(response, 200, sessionPayload(readConfig(), sessionId, factsOf(hooks, sessionId)))
    } catch (error) {
      send(response, 500, { ok: false, error: messageOf(error) })
    }
    return
  }
  if (method !== 'POST' && method !== 'DELETE') {
    send(response, 405, { ok: false, error: 'method ' + method + ' is not allowed' })
    return
  }
  if (!isSameOrigin(request)) {
    logLine(ctx, 'warn', 'cross-origin session write refused')
    send(response, 403, { ok: false, error: 'cross-origin session write refused' })
    return
  }
  if (method === 'DELETE') {
    const sessionId = sessionIdFromQuery(request)
    if (sessionId === undefined) {
      send(response, 400, { ok: false, error: 'sessionId is required' })
      return
    }
    clearOverride(sessionId)
    logLine(ctx, 'info', 'session override cleared')
    send(response, 200, { ok: true, sessionId })
    return
  }
  let text
  try {
    text = await readBody(request)
  } catch (error) {
    send(response, error?.status ?? 400, { ok: false, error: messageOf(error) })
    return
  }
  let payload
  try {
    payload = JSON.parse(text)
  } catch {
    send(response, 400, { ok: false, error: 'invalid JSON' })
    return
  }
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)) {
    send(response, 400, { ok: false, error: 'expected an object of the shape { sessionId, ruleIds, customText }' })
    return
  }
  const rawSessionId = payload.sessionId
  const sessionId = typeof rawSessionId === 'string' && rawSessionId.trim() !== '' ? rawSessionId.trim() : undefined
  if (sessionId === undefined) {
    send(response, 400, { ok: false, error: 'sessionId is required' })
    return
  }
  if (!Array.isArray(payload.ruleIds)) {
    send(response, 400, { ok: false, error: 'ruleIds must be an array of rule ids' })
    return
  }
  const ruleIds = []
  for (const item of payload.ruleIds) {
    if (typeof item !== 'string' || item.trim() === '') {
      send(response, 400, { ok: false, error: 'ruleIds must be an array of rule ids' })
      return
    }
    if (!ruleIds.includes(item.trim())) ruleIds.push(item.trim())
  }
  const customText = payload.customText === undefined || payload.customText === null ? undefined : payload.customText
  if (customText !== undefined && typeof customText !== 'string') {
    send(response, 400, { ok: false, error: 'customText must be a string' })
    return
  }
  if (customText !== undefined && customText.length > MAX_CUSTOM_TEXT_CHARS) {
    send(response, 413, { ok: false, error: 'too large' })
    return
  }
  let config = readConfig()
  const known = new Set((Array.isArray(config.rules) ? config.rules : []).map(rule => rule.id))
  const missing = ruleIds.find(ruleId => !known.has(ruleId))
  if (missing !== undefined) {
    logLine(ctx, 'warn', 'unknown rule id refused: ' + missing)
    send(response, 400, { ok: false, error: 'unknown rule id' })
    return
  }
  if (customText !== undefined && customText.trim() !== '') {
    const rule = customRule(config, customText)
    try {
      config = appendRule(rule)
    } catch (error) {
      send(response, error?.status ?? 500, { ok: false, error: messageOf(error) })
      return
    }
    ruleIds.push(rule.id)
  }
  const saved = setOverride(sessionId, ruleIds)
  logLine(ctx, 'info', 'session override saved with ' + saved.ruleIds.length + ' rule(s)')
  send(response, 200, { ok: true, session: sessionPayload(config, sessionId, factsOf(hooks, sessionId)) })
}

function guarded(ctx, handler) {
  return (request, response) => {
    const fail = error => logLine(ctx, 'warn', 'request failed: ' + messageOf(error))
    let result
    try {
      result = handler(request, response)
    } catch (error) {
      fail(error)
      return undefined
    }
    if (result !== undefined && result !== null && typeof result.then === 'function') {
      result.catch(fail)
      return result
    }
    return result
  }
}

/** @returns the three request handlers bound to this host context; a rejection never escapes. */
export function createHandlers(ctx, hooks = {}) {
  return {
    config: guarded(ctx, (request, response) => handleConfig(ctx, request, response)),
    options: guarded(ctx, (request, response) => handleOptions(ctx, request, response)),
    session: guarded(ctx, (request, response) => handleSession(ctx, request, response, hooks)),
  }
}

function install(ctx, webServer, hooks) {
  const handlers = createHandlers(ctx, hooks)
  const disposers = []
  const routes = [[CONFIG_ROUTE, handlers.config], [OPTIONS_ROUTE, handlers.options], [SESSION_ROUTE, handlers.session]]
  for (const [path, handler] of routes) {
    try {
      disposers.push(webServer.register({ kind: 'exact', path, handler }))
    } catch (error) {
      logLine(ctx, 'warn', 'route ' + path + ' not registered: ' + messageOf(error))
    }
  }
  if (disposers.length === 0) return undefined
  return () => {
    for (const dispose of disposers) {
      attempt(() => {
        if (typeof dispose === 'function') dispose()
      })
    }
  }
}

/**
 * Register every route once per web server; a host without a web server is a
 * no-op rather than a failure.
 * @param hooks - optional `factsForSession(sessionId)`, so GET reports the exact match.
 * @returns whether any route went live.
 */
export function registerRoutes(ctx, hooks) {
  const webServer = attempt(() => ctx?.webServer ?? ctx?.get?.('webServer'))
  if (webServer === undefined || webServer === null || typeof webServer.register !== 'function') return false
  if (registered.has(webServer)) return true
  let dispose
  const run = () => {
    dispose = install(ctx, webServer, hooks)
    return dispose
  }
  try {
    if (typeof ctx.effect === 'function') ctx.effect(run, 'prompt-inject: http routes')
    else run()
  } catch (error) {
    logLine(ctx, 'warn', 'routes not installed: ' + messageOf(error))
  }
  if (typeof dispose !== 'function') return false
  registered.add(webServer)
  return true
}

/**
 * Mount every route now, or wait for a web server the profile loads after this row.
 * @param hooks - optional `factsForSession(sessionId)`, forwarded to the session route.
 * @returns whether the routes are live, or scheduled to go live on injection.
 */
export function mountRoutes(ctx, hooks) {
  if (typeof ctx?.inject !== 'function') return registerRoutes(ctx, hooks)
  try {
    ctx.inject(['webServer'], scoped => {
      if (registerRoutes(scoped, hooks) !== true) registerRoutes(ctx, hooks)
    })
    return true
  } catch (error) {
    logLine(ctx, 'warn', 'webServer injection not requested: ' + messageOf(error))
    return registerRoutes(ctx, hooks)
  }
}
