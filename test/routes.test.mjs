import { EventEmitter } from 'node:events'
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, isMain, ok, suite } from './harness.mjs'

const { test, run } = suite('routes')

const home = mkdtempSync(join(tmpdir(), 'prompt-inject-routes-'))

const { CONFIG_ROUTE, MAX_BODY_BYTES, OPTIONS_ROUTE, SESSION_ROUTE, clearEffortCache, collectOptions, createHandlers, isSameOrigin, mountRoutes, registerRoutes } = await import('../lib/host/routes.js')
const { configPath, defaultConfig, readConfig, writeConfig } = await import('../lib/host/config-store.js')
const { apply } = await import('../lib/host/index.js')

let file = ''
const HOST = '127.0.0.1:58499'

const BANNER = {
  version: 1,
  enabled: true,
  rules: [{ id: 'r-1', name: 'banner', enabled: true, text: 'HELLO', when: { presets: 'all', efforts: 'all', permissions: 'all' } }],
}

function request({ method = 'GET', headers = { host: HOST }, body } = {}) {
  const emitter = new EventEmitter()
  emitter.method = method
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

const handlers = createHandlers({ logger: { info: () => {}, warn: () => {} } })

async function get(route, { headers = { host: HOST } } = {}) {
  const res = response()
  await route(request({ headers }), res)
  return res
}

async function post(route, payload, { headers = { host: HOST, origin: 'http://' + HOST }, raw } = {}) {
  const body = raw === undefined ? JSON.stringify(payload) : raw
  const res = response()
  await route(request({ method: 'POST', headers, body }), res)
  return res
}

test('the routes sit under the documented same-origin prefix', () => {
  eq(CONFIG_ROUTE, '/api/prompt-inject/config')
  eq(OPTIONS_ROUTE, '/api/prompt-inject/options')
  eq(MAX_BODY_BYTES, 256 * 1024)
})

test('isSameOrigin accepts a missing Origin, and only a matching host otherwise', () => {
  ok(isSameOrigin({ headers: { host: HOST } }), 'no Origin header')
  ok(isSameOrigin({ headers: { host: HOST, origin: 'http://' + HOST } }), 'same host')
  ok(!isSameOrigin({ headers: { host: HOST, origin: 'http://evil.example' } }), 'foreign host')
  ok(!isSameOrigin({ headers: { host: HOST, origin: 'not a url' } }), 'malformed origin')
  ok(!isSameOrigin({ headers: { origin: 'http://' + HOST } }), 'origin without host')
  ok(isSameOrigin({}), 'no headers at all')
})

test('GET config serves the default while no file exists and does not create one', async () => {
  ok(!existsSync(file), 'no file yet')
  const res = await get(handlers.config)
  eq(res.status, 200)
  eq(res.payload(), { ok: true, config: defaultConfig() })
  eq(res.headers['cache-control'], 'no-store')
  ok(!existsSync(file), 'a read must not write the file')
})

test('POST config validates, writes atomically and echoes the stored config', async () => {
  const res = await post(handlers.config, { config: BANNER })
  eq(res.status, 200)
  const payload = res.payload()
  eq(payload.ok, true)
  eq(payload.config, BANNER)
  eq(readConfig(), BANNER)
  eq(JSON.parse(readFileSync(file, 'utf8')), BANNER)
  eq(readdirSync(join(home, 'prompt-inject')), ['config.json'], 'no temp file survives')
})

test('POST rejects a body that is not an object', async () => {
  for (const body of ['[]', '"config"', '5', 'null']) {
    const res = await post(handlers.config, undefined, { raw: body })
    eq(res.status, 400, 'body ' + body)
    eq(res.payload().ok, false)
    ok(typeof res.payload().error === 'string' && res.payload().error !== '', 'body ' + body + ' needs an error')
  }
})

test('POST rejects invalid JSON and a missing config key', async () => {
  const broken = await post(handlers.config, undefined, { raw: '{ not json' })
  eq(broken.status, 400)
  eq(broken.payload(), { ok: false, error: 'invalid JSON' })
  const missing = await post(handlers.config, {})
  eq(missing.status, 400)
  eq(missing.payload().ok, false)
})

test('POST rejects the structural shapes the contract forbids', async () => {
  const rejected = [
    { rules: {} },
    { rules: [{ when: { presets: 'all' } }] },
    { rules: [{ text: 5 }] },
    { rules: [{ text: 'x', when: { presets: 'liangshen' } }] },
    { rules: [{ text: 'x', when: { efforts: ['high', 3] } }] },
    { rules: [{ text: 'x', enabled: 'yes' }] },
    { enabled: 'true', rules: [] },
  ]
  for (const config of rejected) {
    const res = await post(handlers.config, { config })
    eq(res.status, 400, JSON.stringify(config))
    eq(res.payload().ok, false, JSON.stringify(config))
  }
  eq(readConfig(), BANNER, 'nothing invalid reached the file')
})

test('POST accepts an unfinished rule and stores it as written', async () => {
  const draft = { version: 1, enabled: true, rules: [{ id: 'r-2', name: 'draft', text: 'DRAFT', when: { presets: 'all', efforts: [] } }] }
  const res = await post(handlers.config, { config: draft })
  eq(res.status, 200)
  ok(res.payload().ok, 'a draft must be accepted')
  eq(res.payload().config.rules[0].when, { presets: 'all', efforts: [] }, 'an unset dimension stays unset')
  eq(res.payload().config.rules[0].enabled, true, 'the echo is the normalized config')
  eq(readConfig(), res.payload().config, 'the response is exactly what landed on disk')
})

test('POST from a foreign origin is refused with 403 and writes nothing', async () => {
  const stored = readConfig()
  const res = await post(handlers.config, { config: { rules: [] } }, { headers: { host: HOST, origin: 'http://evil.example' } })
  eq(res.status, 403)
  eq(res.payload().ok, false)
  eq(readConfig(), stored, 'the config on disk is untouched')
})

test('POST above 256KB is refused', async () => {
  const huge = 'x'.repeat(MAX_BODY_BYTES + 1)
  const res = await post(handlers.config, undefined, { raw: huge })
  eq(res.status, 413)
  eq(res.payload().ok, false)
})

test('an unsupported method is refused on both routes', async () => {
  for (const route of [handlers.config, handlers.options]) {
    const res = response()
    await route(request({ method: 'PUT' }), res)
    eq(res.status, 405)
    eq(res.payload().ok, false)
  }
})

test('GET options offers every candidate with its display label', async () => {
  // Negative control: the registry only answers asynchronously. A synchronous read
  // yields a pending Promise, so the list would fall back to the four static
  // built-ins and liangshen would be missing from this assertion.
  const ctx = {
    agentPresets: {
      list: async () => [{ id: 'liangshen', name: '梁神模式' }, { id: 'standard' }, { id: 'liangshen' }, { name: 'ignored' }, {}],
    },
    permissionPresets: {
      catalog: () => ({
        options: [{ value: 'read-only', name: 'read-only' }, { value: 'workspace-write', name: '工作区内修改' }, { value: 'read-only' }],
      }),
    },
  }
  const collected = await collectOptions(ctx)
  eq(collected.presets, [{ id: 'liangshen', label: '梁神模式' }, { id: 'standard', label: '标准模式' }], 'a third-party preset keeps its own name, a built-in falls back to the official label')
  eq(collected.permissions, [{ id: 'read-only', label: '仅可查看' }, { id: 'workspace-write', label: '工作区内修改' }], 'the official permission label wins, and a repeated option collapses')
  eq(collected.efforts.slice(0, 3), [{ id: 'low', label: '低' }, { id: 'medium', label: '中' }, { id: 'high', label: '高' }], 'the three known efforts come first')

  const res = await get(createHandlers(ctx).options)
  eq(res.status, 200)
  eq(res.payload().ok, true)
  eq(res.payload().presets, collected.presets)
  eq(res.payload().permissions, collected.permissions)
  eq(res.payload().efforts, collected.efforts)
})

test('GET options reads the permission catalog, not a flat listing', async () => {
  // Negative control: this context still offers the old flat list() and no catalog().
  // The card must fall back to the four official rows; reading list() would instead
  // produce the two bare ids.
  const collected = await collectOptions({ permissionPresets: { list: () => ['read-only', 'workspace-write'] } })
  eq(collected.permissions, [
    { id: 'read-only', label: '仅可查看' },
    { id: 'workspace-write', label: '工作区内修改' },
    { id: 'danger-full-access', label: '完全权限' },
    { id: 'auto', label: '自动审查' },
  ])
})

test('GET options falls back to the static candidates when nothing answers', async () => {
  // Negative control: the old behaviour was an empty list here, which left the card blank.
  const staticPresets = [
    { id: 'standard', label: '标准模式' },
    { id: 'ptc', label: 'PTC 模式' },
    { id: 'minimal', label: '极简模式' },
    { id: 'cordis', label: '创造模式' },
  ]
  const staticPermissions = [
    { id: 'read-only', label: '仅可查看' },
    { id: 'workspace-write', label: '工作区内修改' },
    { id: 'danger-full-access', label: '完全权限' },
    { id: 'auto', label: '自动审查' },
  ]
  const bare = await collectOptions({})
  eq(bare.presets, staticPresets, 'no registry at all')
  eq(bare.permissions, staticPermissions)
  eq(bare.efforts, [{ id: 'low', label: '低' }, { id: 'medium', label: '中' }, { id: 'high', label: '高' }])

  const empty = await collectOptions(undefined)
  eq(empty.presets, staticPresets, 'no context at all')

  const throwing = {
    get agentPresets() {
      throw new Error('boom')
    },
    permissionPresets: {
      catalog: () => {
        throw new Error('boom')
      },
    },
  }
  const crashed = await collectOptions(throwing)
  eq(crashed.presets, staticPresets, 'a registry that throws still yields the built-ins')
  eq(crashed.permissions, staticPermissions, 'a catalog that throws still yields the built-ins')

  const refusing = {
    agentPresets: { list: async () => { throw new Error('nope') } },
    permissionPresets: { catalog: () => ({ options: [] }) },
  }
  eq((await collectOptions(refusing)).presets, staticPresets, 'a rejecting list() still yields the built-ins')

  const lonely = await collectOptions({ agentPresets: { list: async () => [{ id: 'liangshen', name: '   ' }] } })
  eq(lonely.presets, [{ id: 'liangshen', label: 'liangshen' }], 'a blank name reads as the id')

  const res = await get(handlers.options)
  eq(res.status, 200)
  eq(res.payload().presets, staticPresets)
})

test('GET options merges the efforts the stored rules already use', async () => {
  writeConfig({ version: 1, enabled: true, rules: [{ id: 'r-e', text: 'E', when: { presets: 'all', efforts: ['high', 'max'], permissions: 'all' } }] })
  try {
    const res = await get(handlers.options)
    eq(res.payload().efforts, [
      { id: 'low', label: '低' },
      { id: 'medium', label: '中' },
      { id: 'high', label: '高' },
      { id: 'max', label: '最高' },
    ], 'an effort only the config knows takes its label from the Chinese table')
  } finally {
    writeConfig(BANNER)
  }
})

test('GET options reads the live reasoning efforts in first-seen order with Chinese labels', async () => {
  // Negative control: without the Chinese table the labels read Off/Low/High/Max, and
  // without the per-model walk the list collapses to the three hard-coded ids.
  clearEffortCache()
  const efforts = {
    'deepseek-flash': [{ id: 'off', name: 'Off' }, { id: 'low', name: 'Low' }, { id: 'high', name: 'High' }, { id: 'max', name: 'Max' }, { id: 'high', name: 'High again' }],
    'deepseek-pro': [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }],
    'gpt-x': [{ id: 'high', name: 'High' }],
  }
  const llm = {
    listProviders: () => [{ id: 'deepseek-account', name: 'DeepSeek' }, { id: 'openai', name: 'OpenAI' }],
    listModels: async provider => (provider === 'deepseek-account'
      ? [{ id: 'deepseek-flash', name: 'Flash' }, { id: 'deepseek-pro', name: 'Pro' }]
      : [{ id: 'gpt-x', name: 'X' }]),
    resolveModelInfo: async (_provider, model) => ({ id: model, name: model, reasoning: { efforts: efforts[model] } }),
  }
  const res = await get(createHandlers({ get: key => (key === 'llm' ? llm : undefined) }).options)
  eq(res.status, 200)
  eq(res.payload().efforts, [
    { id: 'off', label: '关闭' },
    { id: 'low', label: '低' },
    { id: 'high', label: '高' },
    { id: 'max', label: '最高' },
  ], 'four efforts over three models, first-seen order, Chinese labels')
  ok(res.payload().efforts.every(option => option.label !== 'High' && option.label !== 'Max'), 'no English adapter name leaks through')
  clearEffortCache()
})

test('GET options still answers 200 with the three known efforts when no model registry answers', async () => {
  clearEffortCache()
  const staticEfforts = [{ id: 'low', label: '低' }, { id: 'medium', label: '中' }, { id: 'high', label: '高' }]
  const res = await get(createHandlers({ logger: { info: () => {}, warn: () => {} } }).options)
  eq(res.status, 200)
  eq(res.payload().efforts, staticEfforts, 'no llm service at all')

  eq((await collectOptions({ get: () => null })).efforts, staticEfforts, 'a null service reads as absent')
  eq((await collectOptions({ get: () => ({}) })).efforts, staticEfforts, 'a service without the three reads is skipped')
  eq((await collectOptions({ llm: undefined })).efforts, staticEfforts, 'an undefined property reads as absent')
})

test('a failing provider or model is skipped instead of sinking the whole list', async () => {
  clearEffortCache()
  const throwing = {
    get: () => ({
      listProviders: () => { throw new Error('no adapters') },
      listModels: async () => [],
      resolveModelInfo: async () => ({}),
    }),
  }
  const res = await get(createHandlers(throwing).options)
  eq(res.status, 200, 'a throwing listProviders still answers')
  eq(res.payload().efforts, [{ id: 'low', label: '低' }, { id: 'medium', label: '中' }, { id: 'high', label: '高' }], 'the whole lookup falls back')

  clearEffortCache()
  const partial = {
    get: () => ({
      listProviders: () => [{ id: 'good' }, { id: 'bad' }],
      listModels: async provider => {
        if (provider === 'bad') throw new Error('no catalog')
        return [{ id: 'ok' }, { id: 'boom' }]
      },
      resolveModelInfo: async (_provider, model) => {
        if (model === 'boom') throw new Error('adapter refused')
        return { id: model, name: model, reasoning: { efforts: [{ id: 'max', name: 'Max' }, { id: 'medium', name: 'Medium' }] } }
      },
    }),
  }
  const partialRes = await get(createHandlers(partial).options)
  eq(partialRes.status, 200, 'one refusing provider and one rejecting model still answer')
  eq(partialRes.payload().efforts, [{ id: 'max', label: '最高' }, { id: 'medium', label: '中' }], 'the working model contributes, the refusing ones do not')
  clearEffortCache()
})

test('the live lookup is memoized, and a fallback is never memoized', async () => {
  clearEffortCache()
  let providers = 0
  const llm = {
    listProviders: () => {
      providers += 1
      return [{ id: 'p' }]
    },
    listModels: async () => [{ id: 'm' }],
    resolveModelInfo: async () => ({ id: 'm', name: 'm', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }),
  }
  const live = createHandlers({ get: () => llm })
  const first = await get(live.options)
  const second = await get(live.options)
  eq(providers, 1, 'a second call inside the TTL reuses the memoized lookup')
  eq(first.payload().efforts, [{ id: 'high', label: '高' }])
  eq(second.payload().efforts, first.payload().efforts, 'both calls serve the same candidates')

  clearEffortCache()
  let failures = 0
  const broken = {
    get: () => ({
      listProviders: () => {
        failures += 1
        throw new Error('nope')
      },
      listModels: async () => [],
      resolveModelInfo: async () => ({}),
    }),
  }
  const brokenHandler = createHandlers(broken)
  await get(brokenHandler.options)
  await get(brokenHandler.options)
  eq(failures, 2, 'a fallback is retried on the next call instead of being cached')
  clearEffortCache()
})

test('registerRoutes mounts both paths once and tolerates a host without a web server', async () => {
  eq(registerRoutes({ logger: { warn: () => {} } }), false, 'no web server')
  eq(registerRoutes(undefined), false, 'no context')

  const registered = []
  const webServer = { register: options => { registered.push(options); return () => {} } }
  const ctx = { webServer, logger: { warn: () => {} }, effect: factory => factory() }
  eq(registerRoutes(ctx), true, 'first call registers')
  eq(registered.map(options => options.path), [CONFIG_ROUTE, OPTIONS_ROUTE, SESSION_ROUTE])
  eq(registered.map(options => options.kind), ['exact', 'exact', 'exact'])
  ok(registered.every(options => typeof options.handler === 'function'), 'every handler is a function')

  eq(registerRoutes(ctx), true, 'a second call is a no-op')
  eq(registered.length, 3, 'the paths are registered exactly once')

  const broken = { register: () => { throw new Error('path already taken') } }
  eq(registerRoutes({ webServer: broken, logger: { warn: () => {} } }), false, 'a refusing web server is reported, not thrown')
})

test('a web server that arrives late still gets both routes, exactly once', () => {
  let callback
  let deps
  const registeredOn = []
  const webServer = {
    register: options => {
      registeredOn.push(options)
      return () => {}
    },
  }
  const ctx = {
    logger: { warn: () => {} },
    effect: factory => factory(),
    inject: (list, run) => {
      deps = list
      callback = run
    },
  }
  eq(mountRoutes(ctx), true, 'the routes are scheduled while webServer is missing')
  eq(deps, ['webServer'], 'only webServer is injected')
  eq(registeredOn.length, 0, 'nothing is registered before the service arrives')
  ok(typeof callback === 'function', 'the injection callback is remembered')

  const scoped = { webServer, logger: ctx.logger, effect: ctx.effect }
  callback(scoped)
  eq(registeredOn.map(options => options.path), [CONFIG_ROUTE, OPTIONS_ROUTE, SESSION_ROUTE], 'every path lands once the service arrives')
  eq(registeredOn.map(options => options.kind), ['exact', 'exact', 'exact'])
  callback(scoped)
  eq(registeredOn.length, 3, 'a re-delivered service must not register again')
})

test('a web server that never arrives leaves the routes unmounted, and injection still works', async () => {
  writeConfig({ version: 1, enabled: true, rules: [{ id: 'r-9', text: 'STILL-WORKS', when: { presets: 'all', efforts: 'all', permissions: 'all' } }] })
  let callback
  const listeners = []
  const probed = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    effect: factory => factory(),
    inject: (list, run) => {
      callback = run
    },
    get: key => {
      probed.push(key)
      return undefined
    },
    on: (event, handler) => {
      if (event === 'system-prompt/assemble') listeners.push(handler)
    },
  }
  apply(ctx)
  ok(typeof callback === 'function', 'the webServer injection stays pending, never fired')
  eq(probed, [], 'registerRoutes must not be reached without a web server')
  eq(listeners.length, 1, 'the assembly listener is mounted regardless')
  const assembly = { sections: [{ name: 'persona', text: 'BASE' }] }
  const out = await listeners[0](assembly, { agent: { session: { id: 's-none' } } }, async () => assembly)
  ok(out !== assembly, 'the injection path still returns a new assembly')
  eq(out.sections[0].text, 'BASE\n\nSTILL-WORKS', 'injection is untouched by the missing web server')
})

export async function main() {
  process.env.DSH_HOME = home
  file = configPath()
  await run()
}

if (isMain(import.meta.url)) await main()
