import { eq, isMain, ok, suite } from './harness.mjs'
import { dimensionMatches, matches, selectTexts } from '../lib/host/match.js'

const { test, run } = suite('match')

const FACTS = { presetId: 'liangshen', effort: 'high', permission: 'workspace-write' }
const ALL = { presets: 'all', efforts: 'all', permissions: 'all' }
const rule = (when, extra = {}) => ({ text: 't', when, ...extra })

test('dimensionMatches: "all" accepts every value, including an unknown one', () => {
  for (const value of ['liangshen', '', undefined, null, 7])
    ok(dimensionMatches('all', value), 'all should accept ' + JSON.stringify(value))
})

test('dimensionMatches: a non-empty array accepts exactly its strings', () => {
  ok(dimensionMatches(['a', 'b'], 'b'), 'listed value')
  ok(!dimensionMatches(['a', 'b'], 'c'), 'unlisted value')
  ok(!dimensionMatches(['a'], undefined), 'unknown value')
  ok(!dimensionMatches(['a'], null), 'null value')
  ok(!dimensionMatches(['a'], 7), 'non-string value')
  ok(!dimensionMatches(['a'], ''), 'empty value')
  ok(!dimensionMatches(['a', 'b'], 'A'), 'case sensitive')
})

test('dimensionMatches: an unset dimension never matches', () => {
  for (const spec of [undefined, null, [], 'ALL', 'every', {}, 0, false])
    ok(!dimensionMatches(spec, 'liangshen'), 'unset spec ' + JSON.stringify(spec) + ' must not match')
})

test('three "all" dimensions match any session, even with no facts at all', () => {
  ok(matches(rule(ALL), FACTS), 'known facts')
  ok(matches(rule(ALL), {}), 'empty facts')
  ok(matches(rule(ALL), undefined), 'undefined facts')
  ok(matches(rule(ALL), { presetId: undefined, effort: undefined, permission: undefined }), 'explicitly unknown facts')
})

test('a dimension that is not in effect stops the whole rule', () => {
  ok(!matches(rule({ presets: ['liangshen'], efforts: 'all' }), FACTS), 'permissions missing')
  ok(!matches(rule({ presets: 'all', efforts: [], permissions: 'all' }), FACTS), 'efforts empty array')
  ok(!matches(rule({ presets: 'all', efforts: 'all', permissions: undefined }), FACTS), 'permissions undefined')
  ok(!matches(rule({}), FACTS), 'nothing set')
  ok(!matches({ text: 'no when' }, FACTS), 'when missing')
  ok(!matches({ text: 'when is a string', when: 'all' }, FACTS), 'when of the wrong type')
})

test('an array dimension does not accept an unknown fact, while "all" does', () => {
  const onlyPreset = rule({ presets: ['liangshen'], efforts: 'all', permissions: 'all' })
  ok(matches(onlyPreset, { presetId: 'liangshen' }), 'preset known, others unknown')
  ok(!matches(onlyPreset, { presetId: undefined }), 'preset unknown')
  ok(!matches(onlyPreset, {}), 'no facts')
})

test('all three dimensions must accept the fact they test', () => {
  const strict = rule({ presets: ['liangshen', 'other'], efforts: ['high'], permissions: ['workspace-write', 'read-only'] })
  ok(matches(strict, FACTS), 'every dimension accepts')
  ok(!matches(strict, { ...FACTS, presetId: 'third' }), 'preset mismatch')
  ok(!matches(strict, { ...FACTS, effort: 'low' }), 'effort mismatch')
  ok(!matches(strict, { ...FACTS, permission: 'danger-full-access' }), 'permission mismatch')
})

test('a rule with enabled: false is skipped, a rule without enabled is not', () => {
  ok(!matches(rule(ALL, { enabled: false }), FACTS), 'disabled rule')
  ok(matches(rule(ALL), FACTS), 'enabled by default')
  ok(matches(rule(ALL, { enabled: true }), FACTS), 'explicitly enabled')
})

test('three matching rules join with a blank line in array order', () => {
  const config = {
    enabled: true,
    rules: [
      { text: 'one', when: ALL },
      { text: 'two', when: { presets: ['liangshen'], efforts: 'all', permissions: 'all' } },
      { text: 'three', when: { presets: 'all', efforts: ['high'], permissions: 'all' } },
    ],
  }
  eq(selectTexts(config, FACTS), 'one\n\ntwo\n\nthree')
})

test('a repeated text appears once', () => {
  const config = { enabled: true, rules: [{ text: 'same', when: ALL }, { text: 'same', when: ALL }, { text: 'other', when: ALL }, { text: 'same', when: ALL }] }
  eq(selectTexts(config, FACTS), 'same\n\nother')
})

test('a disabled rule and an empty text contribute nothing', () => {
  const config = {
    enabled: true,
    rules: [
      { text: 'skipped', when: ALL, enabled: false },
      { text: '', when: ALL },
      { text: '   ', when: ALL },
      { text: 'kept', when: ALL },
    ],
  }
  eq(selectTexts(config, FACTS), 'kept')
})

test('a disabled top-level config yields nothing', () => {
  eq(selectTexts({ enabled: false, rules: [{ text: 'a', when: ALL }] }, FACTS), '')
})

test('a text already present in the prompt is not appended again', () => {
  const config = { enabled: true, rules: [{ text: 'dup', when: ALL }] }
  eq(selectTexts(config, FACTS, 'prefix dup suffix'), '')
  eq(selectTexts(config, FACTS, 'prefix'), 'dup')
})

test('unexpected shapes do not throw', () => {
  eq(selectTexts(undefined, FACTS), '')
  eq(selectTexts(null, FACTS), '')
  eq(selectTexts('nope', FACTS), '')
  eq(selectTexts({ enabled: true, rules: 'nope' }, FACTS), '')
  eq(selectTexts({ enabled: true, rules: [null, 7, { text: 'only', when: ALL }] }, FACTS), 'only')
  ok(!matches(undefined, FACTS), 'undefined rule')
  ok(!matches(null, FACTS), 'null rule')
  ok(matches(rule(ALL), null), '"all" survives null facts')
  ok(!matches(rule({ presets: ['x'], efforts: 'all', permissions: 'all' }), null), 'null facts fail an array dimension')
})

export async function main() {
  await run()
}

if (isMain(import.meta.url)) await main()
