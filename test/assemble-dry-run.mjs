import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, isMain, ok, suite, throws } from './harness.mjs'

const { test, run } = suite('assemble-dry-run')

const home = mkdtempSync(join(tmpdir(), 'prompt-inject-assemble-'))

const { PERSONA_SECTION_NAMES, apply, collectFacts } = await import('../lib/host/index.js')
const { writeConfig } = await import('../lib/host/config-store.js')
const { clearOverride, setOverride } = await import('../lib/host/session-store.js')

const BASE = 'BASE PERSONA for the dry run: a coding agent on Windows. Bullet one. Bullet two. Bullet three.'
const RULE_TEXT = 'RULE-ONE: appended by dsh-prompt-inject.'
const LIANGSHEN = { presets: ['liangshen'], efforts: 'all', permissions: 'all' }

function useRules(rules, enabled = true) {
  writeConfig({ version: 1, enabled, rules })
}

function banner() {
  useRules([{ id: 'r-1', name: 'banner', enabled: true, text: RULE_TEXT, when: LIANGSHEN }])
}

function fakeContext({ states = {}, projections = true, webServer = true } = {}) {
  const listeners = []
  const ctx = {
    listeners,
    registered: [],
    logger: { info: () => {}, warn: () => {} },
    on: (event, handler) => {
      if (event === 'system-prompt/assemble') listeners.push(handler)
    },
  }
  if (projections) ctx.sessionProjections = { stateOf: (session, key) => states[session?.id]?.[key] }
  if (webServer) {
    ctx.webServer = {
      register: options => {
        ctx.registered.push(options)
        return () => {}
      },
    }
  }
  return ctx
}

async function assemble(ctx, { sessionId = 's1', personaText = BASE, sections, session } = {}) {
  const listener = ctx.listeners[0]
  ok(typeof listener === 'function', 'apply must register a system-prompt/assemble listener')
  const assembly = {
    sections: sections ?? [
      { name: 'deployment:persona', text: personaText },
      { name: 'tools', text: 'TOOLS' },
    ],
  }
  const context = { agent: { session: session ?? { id: sessionId } } }
  const out = await listener(assembly, context, async () => assembly)
  return { assembly, out }
}

test('apply mounts one listener and every route on the fake context', () => {
  const ctx = fakeContext()
  apply(ctx)
  eq(ctx.listeners.length, 1)
  eq(ctx.registered.map(options => options.path), [
    '/api/prompt-inject/config',
    '/api/prompt-inject/options',
    '/api/prompt-inject/session',
  ])
  eq(PERSONA_SECTION_NAMES, ['deployment:persona-prefix', 'deployment:persona', 'persona'])
})

test('a matching preset appends the rule text to the persona section', async () => {
  banner()
  const ctx = fakeContext({ states: { s1: { agentPreset: 'liangshen' } } })
  apply(ctx)
  const { assembly, out } = await assemble(ctx, { sessionId: 's1' })
  const persona = out.sections[0]
  eq(persona.name, 'deployment:persona')
  eq(persona.text, BASE + '\n\n' + RULE_TEXT)
  ok(out !== assembly, 'the returned object must be a new assembly')
  eq(assembly.sections[0].text, BASE, 'the input assembly must stay untouched')
  eq(out.sections[1], assembly.sections[1], 'other sections are reused as they are')
  console.log('  dry-run before persona (tail 80): ' + JSON.stringify(BASE.slice(-80)))
  console.log('  dry-run after  persona (tail 80): ' + JSON.stringify(persona.text.slice(-80)))
})

test('a non-matching preset returns the very same assembly object', async () => {
  banner()
  const ctx = fakeContext({ states: { s2: { agentPreset: 'other' } } })
  apply(ctx)
  const { assembly, out } = await assemble(ctx, { sessionId: 's2' })
  ok(out === assembly, 'the assembly object must not be replaced')
  eq(out.sections[0].text, BASE, 'the persona text must be untouched')
})

test('a second pass over an already injected assembly adds nothing', async () => {
  banner()
  const ctx = fakeContext({ states: { s1: { agentPreset: 'liangshen' } } })
  apply(ctx)
  const first = await assemble(ctx, { sessionId: 's1' })
  const listener = ctx.listeners[0]
  const twice = await listener(first.out, { agent: { session: { id: 's1' } } }, async () => first.out)
  ok(twice === first.out, 'the second pass must return its input object')
  eq(twice.sections[0].text.split(RULE_TEXT).length - 1, 1, 'the rule text appears exactly once')
})

test('an empty persona text becomes exactly the rule text', async () => {
  banner()
  const ctx = fakeContext({ states: { s1: { agentPreset: 'liangshen' } } })
  apply(ctx)
  const { out } = await assemble(ctx, { sessionId: 's1', personaText: '' })
  eq(out.sections[0].text, RULE_TEXT)
  ok(out.sections[0].text !== '', 'the appended text must not be empty')
})

test('two matching rules join with a blank line in config order', async () => {
  useRules([
    { id: 'r-1', text: 'FIRST', when: { presets: 'all', efforts: 'all', permissions: 'all' } },
    { id: 'r-2', text: 'SECOND', when: LIANGSHEN },
  ])
  const ctx = fakeContext({ states: { s1: { agentPreset: 'liangshen' } } })
  apply(ctx)
  const { out } = await assemble(ctx, { sessionId: 's1' })
  eq(out.sections[0].text, BASE + '\n\nFIRST\n\nSECOND')
})

test('a disabled rule and a disabled config inject nothing', async () => {
  useRules([{ id: 'r-1', text: RULE_TEXT, enabled: false, when: LIANGSHEN }])
  const disabledRule = fakeContext({ states: { s1: { agentPreset: 'liangshen' } } })
  apply(disabledRule)
  ok((await assemble(disabledRule, { sessionId: 's1' })).out.sections[0].text === BASE, 'a disabled rule is skipped')

  useRules([{ id: 'r-1', text: RULE_TEXT, when: LIANGSHEN }], false)
  const disabledConfig = fakeContext({ states: { s1: { agentPreset: 'liangshen' } } })
  apply(disabledConfig)
  ok((await assemble(disabledConfig, { sessionId: 's1' })).out.sections[0].text === BASE, 'a disabled config is skipped')
})

test('a rule with an unset dimension never injects', async () => {
  useRules([{ id: 'r-1', text: RULE_TEXT, when: { presets: ['liangshen'], efforts: 'all' } }])
  const ctx = fakeContext({ states: { s1: { agentPreset: 'liangshen' } } })
  apply(ctx)
  const { assembly, out } = await assemble(ctx, { sessionId: 's1' })
  ok(out === assembly, 'a rule whose permissions dimension is unset must not inject')
})

test('the persona-prefix section wins when several persona names are present', async () => {
  banner()
  const ctx = fakeContext({ states: { s1: { agentPreset: 'liangshen' } } })
  apply(ctx)
  const { out } = await assemble(ctx, {
    sessionId: 's1',
    sections: [
      { name: 'persona', text: 'PERSONA' },
      { name: 'deployment:persona-prefix', text: 'PREFIX' },
    ],
  })
  eq(out.sections[0].text, 'PERSONA')
  eq(out.sections[1].text, 'PREFIX\n\n' + RULE_TEXT)
})

test('an assembly without a persona section, or without sections, is returned unchanged', async () => {
  banner()
  const ctx = fakeContext({ states: { s1: { agentPreset: 'liangshen' } } })
  apply(ctx)
  const noPersona = await assemble(ctx, { sessionId: 's1', sections: [{ name: 'tools', text: 'T' }] })
  ok(noPersona.out === noPersona.assembly, 'no persona section')
  const listener = ctx.listeners[0]
  const bare = {}
  ok((await listener(bare, { agent: { session: { id: 's1' } } }, async () => bare)) === bare, 'no sections')
})

test('facts fall back through the session header, the projections and requestHeader', async () => {
  useRules([{ id: 'r-1', text: 'TRIPLE', when: { presets: ['ls'], efforts: ['high'], permissions: ['read-only'] } }])
  const listeners = []
  const ctx = {
    listeners,
    logger: { info: () => {}, warn: () => {} },
    on: (event, handler) => {
      if (event === 'system-prompt/assemble') listeners.push(handler)
    },
    sessionProjections: { stateOf: (session, key) => (key === 'permissions' ? { ver: 1, seq: 2, val: 'read-only' } : undefined) },
  }
  apply(ctx)
  const session = { header: { agentPreset: { ver: 1, seq: 1, val: 'ls' } }, requestHeader: () => ({ config: { reasoningEffort: 'high' } }) }
  eq(collectFacts(ctx, session, { session }), { presetId: 'ls', permission: 'read-only', effort: 'high' })
  const assembly = { sections: [{ name: 'persona', text: 'BASE' }] }
  const out = await listeners[0](assembly, { agent: { session } }, async () => assembly)
  eq(out.sections[0].text, 'BASE\n\nTRIPLE')
})

test('permission falls back from the service to the projection state', () => {
  eq(collectFacts({ permissionPresets: { current: () => 'workspace-write' } }, {}, undefined).permission, 'workspace-write')
  const presetState = { sessionProjections: { stateOf: (session, key) => (key === 'permissions' ? { preset: 'read-only' } : undefined) } }
  eq(collectFacts(presetState, {}, undefined).permission, 'read-only')
  const versioned = { sessionProjections: { stateOf: (session, key) => (key === 'permissions' ? { ver: 1, seq: 2, val: 'read-only' } : undefined) } }
  eq(collectFacts(versioned, {}, undefined).permission, 'read-only')
  eq(collectFacts({}, {}, undefined).permission, undefined)
  const throwing = { permissionPresets: { current: () => { throw new Error('boom') } } }
  eq(collectFacts(throwing, {}, undefined).permission, undefined)
})

test('an adapter-default effort reads as unknown, a real one is used', () => {
  const ctx = fakeContext()
  const withDefaults = { requestHeader: () => ({ config: { reasoningEffort: 'low' }, adapterDefaults: { reasoningEffort: true } }) }
  eq(collectFacts(ctx, withDefaults, undefined), { presetId: undefined, permission: undefined, effort: undefined })
  const plain = { requestHeader: () => ({ config: { reasoningEffort: 'low' } }) }
  eq(collectFacts(ctx, plain, undefined).effort, 'low')
  eq(collectFacts(ctx, { requestHeader: () => undefined }, { options: { reasoningEffort: 'medium' } }).effort, 'medium')
  eq(collectFacts(ctx, { requestHeader: () => undefined }, undefined), { presetId: undefined, permission: undefined, effort: undefined })
})

test('a host without the projection, permission and header services degrades instead of throwing', async () => {
  banner()
  const ctx = fakeContext({ projections: false, webServer: false })
  apply(ctx)
  const session = {
    requestHeader: () => {
      throw new Error('no header here')
    },
  }
  const assembly = { sections: [{ name: 'persona', text: 'BASE' }] }
  const out = await ctx.listeners[0](assembly, { agent: { session } }, async () => assembly)
  ok(out === assembly, 'nothing is injected without facts')
  eq(collectFacts(ctx, session, { session }), { presetId: undefined, permission: undefined, effort: undefined })
  ok(ctx.listeners.length === 1 && ctx.registered.length === 0, 'the listener mounted, the routes degraded')
})

/**
 * Mirror of the host interpolator in @deepseek-ai/dsh-system-prompt
 * (renderPrompt -> interpolate): same group regex, same name grammar, same throws.
 * A raw `{{name}}` in an interpolated section therefore fails here exactly as it
 * fails in a real turn.
 */
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

test('the mirrored host renderer rejects a raw reference, so the escape cases are real', () => {
  const error = throws(() => renderSection({ name: 'deployment:persona-prefix', text: 'A {{user}} B' }))
  ok(String(error.message).includes('unknown prompt variable'), 'the failure the user reported: ' + error.message)
})

test('a {{user}} reference in the rule text reaches the model literally instead of failing', async () => {
  useRules([{ id: 'r-1', name: 'braces', enabled: true, text: 'GREETING: 你好 {{user}}，模型是 {{model}}。', when: LIANGSHEN }])
  const ctx = fakeContext({ states: { s1: { agentPreset: 'liangshen' } } })
  apply(ctx)
  const { out } = await assemble(ctx, { sessionId: 's1' })
  const rendered = renderSection(out.sections[0], out.variables ?? {})
  eq(rendered, BASE + '\n\nGREETING: 你好 {{user}}，模型是 {{model}}。')
  ok(out.variables !== undefined && typeof out.variables.pinlb === 'string', 'the escape variable must be registered on the assembly')
})

test('malformed references and lone double braces survive verbatim too', async () => {
  const nasty = 'A {{ a.b }} B {{}} C {{ open only D {{pinlb}} E'
  useRules([{ id: 'r-1', name: 'nasty', enabled: true, text: nasty, when: LIANGSHEN }])
  const ctx = fakeContext({ states: { s1: { agentPreset: 'liangshen' } } })
  apply(ctx)
  const { out } = await assemble(ctx, { sessionId: 's1' })
  eq(renderSection(out.sections[0], out.variables ?? {}), BASE + '\n\n' + nasty)
})

test('prose without braces is appended unchanged and registers no variable', async () => {
  banner()
  const ctx = fakeContext({ states: { s1: { agentPreset: 'liangshen' } } })
  apply(ctx)
  const { out } = await assemble(ctx, { sessionId: 's1' })
  eq(out.sections[0].text, BASE + '\n\n' + RULE_TEXT)
  ok(out.variables === undefined, 'no escape variable is needed')
})

test('a verbatim section takes the raw text and gains no variable', async () => {
  useRules([{ id: 'r-1', name: 'verbatim', enabled: true, text: 'RAW {{user}}', when: LIANGSHEN }])
  const ctx = fakeContext({ states: { s1: { agentPreset: 'liangshen' } } })
  apply(ctx)
  const { out } = await assemble(ctx, {
    sessionId: 's1',
    sections: [{ name: 'deployment:persona', text: 'BASE', interpolate: false }],
  })
  eq(out.sections[0].text, 'BASE\n\nRAW {{user}}')
  ok(out.variables === undefined, 'a verbatim section must not be escaped')
  eq(renderSection(out.sections[0], {}), 'BASE\n\nRAW {{user}}')
})

test('a second pass over injected braces text stays idempotent', async () => {
  useRules([{ id: 'r-1', name: 'braces', enabled: true, text: 'ONCE {{user}}', when: LIANGSHEN }])
  const ctx = fakeContext({ states: { s1: { agentPreset: 'liangshen' } } })
  apply(ctx)
  const first = await assemble(ctx, { sessionId: 's1' })
  const twice = await ctx.listeners[0](first.out, { agent: { session: { id: 's1' } } }, async () => first.out)
  eq(twice, first.out, 'the second pass must return its input object untouched')
  eq(renderSection(twice.sections[0], twice.variables ?? {}).split('ONCE {{user}}').length - 1, 1, 'the text appears exactly once after rendering')
})

test('a session override picks the rules, the conditions keep the dry run unchanged', async () => {
  useRules([
    { id: 'r-1', text: 'BY-CONDITION', when: LIANGSHEN },
    { id: 'r-2', text: 'BY-OVERRIDE', when: {} },
  ])
  const ctx = fakeContext({ states: { s1: { agentPreset: 'liangshen' } } })
  apply(ctx)
  clearOverride('s1')
  const before = await assemble(ctx, { sessionId: 's1' })
  eq(before.out.sections[0].text, BASE + '\n\nBY-CONDITION', 'the dry run without an override is unchanged')
  setOverride('s1', ['r-2'])
  const after = await assemble(ctx, { sessionId: 's1' })
  eq(after.out.sections[0].text, BASE + '\n\nBY-OVERRIDE', 'the override replaces the condition match')
  setOverride('s2', ['r-2'])
  const other = await assemble(ctx, { sessionId: 's2' })
  eq(other.out.sections[0].text, BASE + '\n\nBY-OVERRIDE', 'an override applies to its own session only')
  const untouched = await assemble(ctx, { sessionId: 's2' })
  clearOverride('s2')
  eq((await assemble(ctx, { sessionId: 's2' })).out.sections[0].text, BASE, 's2 has no rule of its own once cleared')
  ok(untouched.out.sections[0].text === BASE + '\n\nBY-OVERRIDE', 'the earlier pass is not retroactively changed')
})

export async function main() {
  process.env.DSH_HOME = home
  await run()
}

if (isMain(import.meta.url)) await main()
