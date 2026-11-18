/**
 * dsh-prompt-inject config file: `<DSH_HOME>/prompt-inject/config.json`, read
 * through an mtime+size keyed cache and written atomically (temp file + rename).
 * @module dsh-prompt-inject/host/config-store
 */
import { mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** Directory created below DSH_HOME. */
export const CONFIG_DIR = 'prompt-inject'

/** File name inside CONFIG_DIR. */
export const CONFIG_FILE = 'config.json'

/** Schema version written into every file this plugin produces. */
export const CONFIG_VERSION = 1

/** The three match dimensions, in a fixed order. */
export const DIMENSIONS = ['presets', 'efforts', 'permissions']

/** Last successful read, keyed by path + mtime + size. */
let cache = { file: undefined, mtimeMs: undefined, size: undefined, config: undefined }

/** @returns DSH_HOME from the environment, else ~/.dsh. */
export function dshHome() {
  const configured = process.env.DSH_HOME
  if (typeof configured === 'string' && configured.trim() !== '') return configured.trim()
  return join(homedir(), '.dsh')
}

/** @returns the absolute path of this plugin's config file. */
export function configPath() {
  return join(dshHome(), CONFIG_DIR, CONFIG_FILE)
}

/** @returns a fresh default config: enabled, no rules. */
export function defaultConfig() {
  return { version: CONFIG_VERSION, enabled: true, rules: [] }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function dimension(value, label, errors) {
  if (value === undefined || value === null) return undefined
  if (value === 'all') return 'all'
  if (!Array.isArray(value)) {
    errors.push(label + ' must be "all" or an array of strings')
    return undefined
  }
  const accepted = []
  for (const item of value) {
    if (typeof item !== 'string') {
      errors.push(label + ' must contain only strings')
      return undefined
    }
    const trimmed = item.trim()
    if (trimmed === '') {
      errors.push(label + ' must not contain empty strings')
      return undefined
    }
    if (!accepted.includes(trimmed)) accepted.push(trimmed)
  }
  return accepted
}

/**
 * Validate one config object and return its normalized form.
 * @returns `{ ok: true, config }`, or `{ ok: false, error, errors, config }` with the first problem in `error`.
 */
export function normalizeConfig(value) {
  const errors = []
  if (!isPlainObject(value)) {
    const message = 'config must be a JSON object'
    return { ok: false, error: message, errors: [message], config: defaultConfig() }
  }
  const version = value.version === undefined ? CONFIG_VERSION : value.version
  if (typeof version !== 'number' || !Number.isFinite(version)) errors.push('version must be a number')
  const enabled = value.enabled === undefined ? true : value.enabled
  if (typeof enabled !== 'boolean') errors.push('enabled must be a boolean')
  const rules = []
  const rawRules = value.rules === undefined || value.rules === null ? [] : value.rules
  if (!Array.isArray(rawRules)) errors.push('rules must be an array')
  else {
    rawRules.forEach((raw, index) => {
      const at = 'rules[' + index + ']'
      if (!isPlainObject(raw)) {
        errors.push(at + ' must be an object')
        return
      }
      if (typeof raw.text !== 'string') {
        errors.push(at + '.text must be a string')
        return
      }
      if (raw.text.trim() === '') {
        errors.push(at + '.text must not be empty')
        return
      }
      const ruleEnabled = raw.enabled === undefined ? true : raw.enabled
      if (typeof ruleEnabled !== 'boolean') {
        errors.push(at + '.enabled must be a boolean')
        return
      }
      const rawWhen = raw.when === undefined || raw.when === null ? {} : raw.when
      if (!isPlainObject(rawWhen)) {
        errors.push(at + '.when must be an object')
        return
      }
      if (raw.id !== undefined && typeof raw.id !== 'string') {
        errors.push(at + '.id must be a string')
        return
      }
      if (raw.name !== undefined && typeof raw.name !== 'string') {
        errors.push(at + '.name must be a string')
        return
      }
      const when = {}
      for (const name of DIMENSIONS) {
        const spec = dimension(rawWhen[name], at + '.when.' + name, errors)
        if (spec !== undefined) when[name] = spec
      }
      const label = typeof raw.name === 'string' ? raw.name.trim() : ''
      const id = typeof raw.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : 'r-' + (index + 1)
      rules.push({ id, name: label, enabled: ruleEnabled, text: raw.text, when })
    })
  }
  const config = {
    version: typeof version === 'number' && Number.isFinite(version) ? version : CONFIG_VERSION,
    enabled: typeof enabled === 'boolean' ? enabled : true,
    rules,
  }
  return errors.length === 0 ? { ok: true, config } : { ok: false, error: errors[0], errors, config }
}

/** Drop the cache so the next read re-stats the file. */
export function forgetConfig() {
  cache = { file: undefined, mtimeMs: undefined, size: undefined, config: undefined }
}

/**
 * Read the config; a missing, unreadable or corrupt file reads as the default.
 * @returns a normalized copy of the config, never the cached object itself.
 */
export function readConfig() {
  const file = configPath()
  let stat
  try {
    stat = statSync(file)
  } catch {
    forgetConfig()
    return defaultConfig()
  }
  if (cache.file === file && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size && cache.config !== undefined) {
    return clone(cache.config)
  }
  let normalized
  try {
    normalized = normalizeConfig(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    normalized = { ok: false }
  }
  const config = normalized.ok ? normalized.config : defaultConfig()
  cache = { file, mtimeMs: stat.mtimeMs, size: stat.size, config }
  return clone(config)
}

/**
 * Write the config atomically: temp file in the same directory, then rename over the target.
 * @returns the normalized config that landed on disk.
 */
export function writeConfig(value) {
  const normalized = normalizeConfig(value)
  if (!normalized.ok) {
    const error = new Error(normalized.error)
    error.status = 400
    error.errors = normalized.errors
    throw error
  }
  const file = configPath()
  mkdirSync(dirname(file), { recursive: true })
  const temporary = file + '.' + process.pid + '-' + Date.now().toString(36) + '.tmp'
  try {
    writeFileSync(temporary, JSON.stringify(normalized.config, null, 2) + '\n', 'utf8')
    renameSync(temporary, file)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      /* the rename already consumed it */
    }
    throw error
  }
  forgetConfig()
  return clone(normalized.config)
}

/**
 * Append one rule to the file, leaving every other rule untouched.
 * @param rule - the rule to add; it is normalized together with the rest of the file.
 * @returns the config that landed on disk, now holding the appended rule.
 */
export function appendRule(rule) {
  const current = readConfig()
  const rules = Array.isArray(current.rules) ? current.rules : []
  return writeConfig({ ...current, rules: [...rules, rule] })
}
