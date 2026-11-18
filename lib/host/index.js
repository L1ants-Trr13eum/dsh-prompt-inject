/**
 * dsh-prompt-inject host half: on every prompt assembly, append the texts of the
 * rules that match this session to the persona section, and serve the rule set to
 * the settings card.
 *
 * Position: the append lands inside the persona section rather than in a section
 * of its own, because a preset's minimal-prompt filter keeps only the section
 * names it knows (persona/tools/plan) and would drop a new one.
 * @module dsh-prompt-inject/host
 */
import { readConfig } from './config-store.js'
import { selectTexts } from './match.js'
import { mountRoutes } from './routes.js'
import { overrideOf, sessionIdOf } from './session-store.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'prompt-inject'

/** The prompt registry must exist before the assembly listener can register. */
export const inject = ['systemPrompt']

/** Section names carrying a preset persona, in the order they are tried. */
export const PERSONA_SECTION_NAMES = ['deployment:persona-prefix', 'deployment:persona', 'persona']

/**
 * Base name of the prompt variable used to keep a literal `{{` alive through
 * interpolation: its value is `{{`, so `{{pinlb}}` renders back as `{{`. The host
 * interpolator (`@deepseek-ai/dsh-system-prompt`) throws on an unregistered name and
 * on a malformed group, so injected prose must never contain a bare `{{`.
 */
export const LITERAL_BRACE_VARIABLE = 'pinlb'

/**
 * Rewrite every `{{` into the escape reference, so the interpolator reproduces the
 * original text byte for byte.
 * @returns the text with each double brace replaced by one escape reference.
 */
export function literalizePlaceholders(text, variableName = LITERAL_BRACE_VARIABLE) {
  return typeof text === 'string' ? text.split('{{').join('{{' + variableName + '}}') : text
}

/**
 * A name already holding the literal `{{` is reused rather than avoided, so the
 * escape stays stable across repeated passes and the dedupe keeps working.
 * @returns a usable variable name, or undefined when injection would break the turn.
 */
export function pickVariableName(variables) {
  const taken = variables !== null && typeof variables === 'object' ? variables : {}
  const usable = name => !Object.hasOwn(taken, name) || taken[name] === '{{'
  if (usable(LITERAL_BRACE_VARIABLE)) return LITERAL_BRACE_VARIABLE
  for (let index = 2; index < 100; index += 1) {
    const candidate = LITERAL_BRACE_VARIABLE + index
    if (usable(candidate)) return candidate
  }
  return undefined
}

/** One assembly log line per process keeps the host log readable. */
let announced = false

function attempt(run) {
  try {
    return run()
  } catch {
    return undefined
  }
}

function unwrap(value) {
  if (typeof value === 'string') return value.trim() === '' ? undefined : value
  if (value !== null && typeof value === 'object') {
    for (const key of ['val', 'value', 'id', 'name']) {
      const inner = attempt(() => value[key])
      if (typeof inner === 'string' && inner.trim() !== '') return inner
    }
  }
  return undefined
}

function serviceOf(ctx, key) {
  return attempt(() => ctx?.[key]) ?? attempt(() => ctx?.get?.(key))
}

function projectionOf(ctx, session, key) {
  if (session === null || session === undefined) return undefined
  const projections = serviceOf(ctx, 'sessionProjections')
  const stateOf = attempt(() => projections?.stateOf)
  if (typeof stateOf !== 'function') return undefined
  return attempt(() => stateOf.call(projections, session, key))
}

function permissionOf(ctx, session) {
  const direct = unwrap(attempt(() => serviceOf(ctx, 'permissionPresets')?.current?.(session)))
  if (direct !== undefined) return direct
  const state = projectionOf(ctx, session, 'permissions')
  const preset = unwrap(attempt(() => state?.preset))
  return preset ?? unwrap(state)
}

function headerEffort(session) {
  const header = attempt(() => session?.requestHeader?.())
  if (header === null || header === undefined) return undefined
  if (attempt(() => header.adapterDefaults?.reasoningEffort) === true) return undefined
  return unwrap(attempt(() => header?.config?.reasoningEffort))
}

/**
 * Read the three facts the rules match on, each behind its own fallback chain;
 * a service this host does not expose reads as "unknown" instead of throwing.
 * @returns `{ presetId, permission, effort }`, any of them possibly undefined.
 */
export function collectFacts(ctx, session, agent) {
  const presetId =
    unwrap(projectionOf(ctx, session, 'agentPreset')) ??
    unwrap(attempt(() => agent?.session?.header?.agentPreset)) ??
    unwrap(attempt(() => session?.header?.agentPreset))
  const permission = permissionOf(ctx, session)
  const selection = projectionOf(ctx, session, 'modelSelection')
  const effort =
    unwrap(attempt(() => selection?.pending?.reasoningEffort)) ??
    unwrap(attempt(() => selection?.lastUsed?.reasoningEffort)) ??
    unwrap(attempt(() => agent?.options?.reasoningEffort)) ??
    headerEffort(session)
  return { presetId, permission, effort }
}

function personaSectionOf(sections) {
  for (const wanted of PERSONA_SECTION_NAMES) {
    const found = sections.find(section => section?.name === wanted && typeof section?.text === 'string')
    if (found !== undefined) return found
  }
  return undefined
}

/** Conditions forced onto every rule an override names: nothing may filter it out. */
const UNCONDITIONAL_WHEN = { presets: 'all', efforts: 'all', permissions: 'all' }

/**
 * Reduce a config to the rules one override names, with their conditions
 * neutralized, so the ordinary selection path still does the joining, the
 * de-duplication and the escaping.
 * @returns a config view holding only the pinned rules, in config order.
 */
export function overrideConfig(config, ruleIds) {
  const wanted = new Set(Array.isArray(ruleIds) ? ruleIds : [])
  const rules = (Array.isArray(config?.rules) ? config.rules : [])
    .filter(rule => rule !== null && typeof rule === 'object' && wanted.has(rule.id))
    .map(rule => ({ ...rule, when: { ...UNCONDITIONAL_WHEN } }))
  return { ...config, rules }
}

/**
 * The paragraphs one assembly receives: the override's rules when this session
 * pins any, the condition match otherwise.
 * @param sessionId - the id the assembly belongs to; undefined means "no session".
 * @returns the text to append, or an empty string.
 */
export function selectTextsForSession(config, facts, sessionId, existing = '', transform = undefined) {
  const override = overrideOf(sessionId)
  if (override === null) return selectTexts(config, facts, existing, transform)
  return selectTexts(overrideConfig(config, override.ruleIds), facts, existing, transform)
}

/**
 * Append the matching rule texts to one assembly's persona section.
 * @returns the same assembly object when nothing applies, a new one when text is added.
 */
export function withInjectedText(assembly, ctx, session, agent) {
  const sections = Array.isArray(assembly?.sections) ? assembly.sections : undefined
  if (sections === undefined) return assembly
  const persona = personaSectionOf(sections)
  if (persona === undefined) return assembly
  const config = readConfig()
  if (config.enabled === false) return assembly
  // A section marked `interpolate: false` is emitted verbatim, so escaping there
  // would leak the escape reference into the prompt.
  const verbatimSection = persona.interpolate === false
  const variableName = verbatimSection ? undefined : pickVariableName(assembly.variables)
  if (!verbatimSection && variableName === undefined) return assembly
  const transform = verbatimSection ? undefined : text => literalizePlaceholders(text, variableName)
  const extra = selectTextsForSession(config, collectFacts(ctx, session, agent), sessionIdOf(session), persona.text, transform)
  if (extra === '') return assembly
  const text = persona.text === '' ? extra : persona.text + '\n\n' + extra
  const next = { ...assembly, sections: sections.map(section => (section === persona ? { ...section, text } : section)) }
  if (!verbatimSection && extra.includes('{{' + variableName + '}}')) {
    next.variables = { ...(assembly.variables ?? {}), [variableName]: '{{' }
  }
  return next
}

/**
 * Resolve the match facts of a session the HTTP half only knows by id, so its
 * `defaultRuleIds` is the exact condition match rather than an approximation.
 * @returns `{ presetId, permission, effort }`, or undefined when the session is not live.
 */
export function sessionFactsFor(ctx, sessionId) {
  const sessions = serviceOf(ctx, 'sessions')
  const session = attempt(() => sessions?.get?.(sessionId))
  if (session === null || session === undefined) return undefined
  return collectFacts(ctx, session, undefined)
}

/**
 * Mount the assembly hook and the HTTP routes; a missing service degrades rather
 * than failing the plugin, and the routes wait for a web server that arrives later.
 * @param ctx - the context the patch-layer row mounts into.
 */
export function apply(ctx) {
  if (typeof ctx?.on === 'function') {
    ctx.on('system-prompt/assemble', async (assembly, context, next) => {
      const assembled = typeof next === 'function' ? await next() : assembly
      try {
        const agent = context?.agent
        const session = context?.session ?? agent?.session
        const injected = withInjectedText(assembled, ctx, session, agent)
        if (injected !== assembled && !announced) {
          announced = true
          attempt(() => ctx.logger?.info?.('dsh-prompt-inject: rule text appended to the persona section'))
        }
        return injected
      } catch (error) {
        attempt(() => ctx.logger?.warn?.('dsh-prompt-inject: injection skipped: ' + (error?.message ?? error)))
        return assembled
      }
    })
  }
  mountRoutes(ctx, { factsForSession: sessionId => sessionFactsFor(ctx, sessionId) })
}
