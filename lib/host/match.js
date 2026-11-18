/**
 * Pure matching helpers: which rules apply to a session, and how their texts join.
 * Dimensions are tri-state ("all" / non-empty array / unset); there is no
 * wildcard form, and a dimension that is not in effect stops the whole rule.
 * @module dsh-prompt-inject/host/match
 */

const DIMENSIONS = [
  ['presets', 'presetId'],
  ['efforts', 'effort'],
  ['permissions', 'permission'],
]

/**
 * Does one dimension accept this session value?
 * @returns true for "all"; for an array only when the value is one of its strings; false otherwise.
 */
export function dimensionMatches(spec, value) {
  if (spec === 'all') return true
  if (!Array.isArray(spec) || spec.length === 0) return false
  return typeof value === 'string' && spec.includes(value)
}

/**
 * Does the rule apply to these facts? A rule counts as enabled unless `enabled`
 * is exactly false; all three dimensions must be in effect and must accept.
 * @returns whether the rule injects into this session.
 */
export function matches(rule, facts) {
  if (rule === null || typeof rule !== 'object') return false
  if (rule.enabled === false) return false
  const when = rule.when !== null && typeof rule.when === 'object' && !Array.isArray(rule.when) ? rule.when : {}
  for (const [dimension, fact] of DIMENSIONS) {
    const value = facts === null || facts === undefined ? undefined : facts[fact]
    if (!dimensionMatches(when[dimension], value)) return false
  }
  return true
}

/**
 * Join the matching rule texts with a blank line, dropping disabled rules, empty
 * texts, repeats and anything already carried by `existing`.
 * @param transform - maps a rule text to the exact form appended to the prompt; dedupe
 *   checks both the raw text and that form, so a second pass over an injected
 *   assembly stays idempotent.
 * @returns the paragraph to append, or an empty string when nothing applies.
 */
export function selectTexts(config, facts, existing = '', transform = undefined) {
  if (config === null || typeof config !== 'object' || Array.isArray(config)) return ''
  if (config.enabled === false) return ''
  const rules = Array.isArray(config.rules) ? config.rules : []
  const seen = new Set()
  const parts = []
  for (const rule of rules) {
    if (!matches(rule, facts)) continue
    if (typeof rule.text !== 'string' || rule.text.trim() === '') continue
    if (seen.has(rule.text)) continue
    const form = typeof transform === 'function' ? transform(rule.text) : rule.text
    if (typeof form !== 'string' || form === '') continue
    if (typeof existing === 'string') {
      const raw = existing.includes(rule.text)
      if (raw || (form !== rule.text && existing.includes(form))) continue
    }
    seen.add(rule.text)
    parts.push(form)
  }
  return parts.join('\n\n')
}
