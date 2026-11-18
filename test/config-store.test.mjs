import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { eq, isMain, ok, suite, throws } from './harness.mjs'

const { test, run } = suite('config-store')

const home = mkdtempSync(join(tmpdir(), 'prompt-inject-store-'))

const { CONFIG_DIR, configPath, defaultConfig, dshHome, normalizeConfig, readConfig, writeConfig } = await import('../lib/host/config-store.js')

let directory = ''
let file = ''
let clock = 0

function writeRaw(text) {
  mkdirSync(directory, { recursive: true })
  writeFileSync(file, text, 'utf8')
  clock += 1
  const at = new Date(Date.now() + clock * 1000)
  utimesSync(file, at, at)
}

const ALL = '"presets":"all","efforts":"all","permissions":"all"'

test('a missing file reads as the default config and is not created', () => {
  ok(!existsSync(file), 'the file must not exist yet')
  eq(readConfig(), defaultConfig())
  ok(!existsSync(file), 'a read must not create the file')
})

test('the config path follows DSH_HOME, else ~/.dsh', () => {
  eq(configPath(), join(home, CONFIG_DIR, 'config.json'))
  delete process.env.DSH_HOME
  eq(dshHome(), join(homedir(), '.dsh'))
  eq(configPath(), join(homedir(), '.dsh', CONFIG_DIR, 'config.json'))
  process.env.DSH_HOME = home
})

test('a written config reads back and leaves no temp file behind', () => {
  const written = writeConfig({
    version: 1,
    enabled: false,
    rules: [{ id: 'r-1', name: 'n', enabled: true, text: 'hello', when: { presets: ['liangshen'], efforts: 'all' } }],
  })
  eq(written.enabled, false)
  eq(written.rules[0].when.presets, ['liangshen'])
  eq(written.rules[0].when.efforts, 'all')
  eq(written.rules[0].when.permissions, undefined)
  ok(readFileSync(file, 'utf8').endsWith('\n'), 'the file ends with a newline')
  eq(readConfig(), written)
  eq(readdirSync(directory), ['config.json'], 'no temp file survives the rename')
})

test('an out-of-band rewrite becomes visible once mtime and size change', () => {
  writeRaw('{"version":1,"enabled":true,"rules":[{"id":"r-1","text":"AAAA","when":{' + ALL + '}}]}')
  eq(readConfig().rules[0].text, 'AAAA')
  writeRaw('{"version":1,"enabled":true,"rules":[{"id":"r-1","text":"BBBBBB","when":{' + ALL + '}}]}')
  eq(readConfig().rules[0].text, 'BBBBBB')
})

test('a rewrite that keeps both mtime and size is served from the cache', () => {
  const rawA = '{"version":1,"enabled":true,"rules":[{"id":"r-1","text":"AAAA","when":{' + ALL + '}}]}'
  const rawB = rawA.replace('"AAAA"', '"BBBB"')
  ok(rawA.length === rawB.length, 'the two bodies must have the same length')
  writeRaw(rawA)
  eq(readConfig().rules[0].text, 'AAAA')
  const before = statSync(file)
  writeFileSync(file, rawB, 'utf8')
  utimesSync(file, before.atime, before.mtime)
  const after = statSync(file)
  ok(after.size === before.size, 'size unchanged')
  ok(after.mtimeMs === before.mtimeMs, 'mtime unchanged')
  eq(readConfig().rules[0].text, 'AAAA', 'the cached parse still answers')
  writeRaw(rawB)
  eq(readConfig().rules[0].text, 'BBBB', 'a new mtime re-reads the file')
})

test('corrupt JSON reads as the default config without throwing', () => {
  writeRaw('{ this is not json')
  eq(readConfig(), defaultConfig())
})

test('a structurally invalid file reads as the default config', () => {
  writeRaw('{"enabled":true,"rules":[{"name":"no text"}]}')
  eq(readConfig(), defaultConfig())
  writeRaw('{"enabled":true,"rules":[{"text":"x","when":{"presets":"liangshen"}}]}')
  eq(readConfig(), defaultConfig())
})

test('validation rejects structural problems', () => {
  const rejected = [
    ['not an object', ['rules']],
    ['null', null],
    ['rules not an array', { rules: {} }],
    ['rule not an object', { rules: ['x'] }],
    ['rule without text', { rules: [{ when: {} }] }],
    ['text not a string', { rules: [{ text: 5 }] }],
    ['text empty', { rules: [{ text: '   ' }] }],
    ['enabled not boolean', { rules: [{ text: 'x', enabled: 'yes' }] }],
    ['when not an object', { rules: [{ text: 'x', when: ['all'] }] }],
    ['dimension is a plain string', { rules: [{ text: 'x', when: { presets: 'liangshen' } }] }],
    ['dimension is a number', { rules: [{ text: 'x', when: { efforts: 3 } }] }],
    ['dimension entry not a string', { rules: [{ text: 'x', when: { permissions: ['read-only', 2] } }] }],
    ['dimension entry empty', { rules: [{ text: 'x', when: { permissions: ['  '] } }] }],
    ['id not a string', { rules: [{ id: 7, text: 'x' }] }],
    ['name not a string', { rules: [{ name: [], text: 'x' }] }],
    ['top-level enabled not boolean', { enabled: 'true', rules: [] }],
    ['version not a number', { version: 'one', rules: [] }],
  ]
  for (const [label, value] of rejected) {
    const result = normalizeConfig(value)
    ok(!result.ok, label + ' must be rejected')
    ok(typeof result.error === 'string' && result.error !== '', label + ' needs an error message')
  }
})

test('an unfinished rule is structurally legal and is not a 400', () => {
  const draft = normalizeConfig({ rules: [{ text: 'draft', when: { presets: 'all', efforts: [] } }] })
  ok(draft.ok, 'a draft must be accepted')
  eq(draft.config.rules[0].when, { presets: 'all', efforts: [] })
  const bare = normalizeConfig({ rules: [{ text: 'bare' }] })
  ok(bare.ok, 'a rule without when must be accepted')
  eq(bare.config.rules[0].when, {})
})

test('defaults are filled in and dimension values are trimmed and de-duplicated', () => {
  const result = normalizeConfig({ rules: [{ text: 'x', when: { presets: [' a ', 'a', 'b'] } }] })
  ok(result.ok, 'valid config')
  eq(result.config.version, 1)
  eq(result.config.enabled, true)
  eq(result.config.rules[0].id, 'r-1')
  eq(result.config.rules[0].name, '')
  eq(result.config.rules[0].enabled, true)
  eq(result.config.rules[0].when.presets, ['a', 'b'])
})

test('writing an invalid config throws and leaves the file untouched', () => {
  const before = readFileSync(file, 'utf8')
  const error = throws(() => writeConfig({ rules: 'nope' }), 'writeConfig')
  eq(error.status, 400)
  eq(readFileSync(file, 'utf8'), before)
})

export async function main() {
  process.env.DSH_HOME = home
  directory = join(home, CONFIG_DIR)
  file = configPath()
  await run()
}

if (isMain(import.meta.url)) await main()
