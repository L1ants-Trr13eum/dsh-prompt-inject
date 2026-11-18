/**
 * Session-scoped injection overrides: the rule ids one session pins instead of
 * letting the condition match decide. Held in memory, so a host restart forgets
 * them, and a session that is gone leaves nothing behind.
 * @module dsh-prompt-inject/host/session-store
 */

/** Live overrides, keyed by session id. Only DELETE or a restart empties it. */
const overrides = new Map()

function attempt(run) {
  try {
    return run()
  } catch {
    return undefined
  }
}

function usableId(value) {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined
}

/**
 * Resolve the id an assembly belongs to. `Session.id` is the durable identity
 * (`get id() { return this.header.id }`, dsh-session/src/index.ts:580); the
 * lighter shapes cover hosts that hand the hook something else.
 * @returns the id, or undefined when nothing usable is there — this never throws.
 */
export function sessionIdOf(session) {
  if (session === null || session === undefined) return undefined
  const direct = usableId(attempt(() => session.id))
  if (direct !== undefined) return direct
  const aliased = usableId(attempt(() => session.sessionId))
  if (aliased !== undefined) return aliased
  return usableId(attempt(() => session.header?.id))
}

/** @returns a copy of the override, or null when the session pins nothing. */
export function overrideOf(sessionId) {
  const id = usableId(sessionId)
  if (id === undefined) return null
  const entry = overrides.get(id)
  return entry === undefined ? null : { ruleIds: entry.ruleIds.slice() }
}

/** @returns how many sessions currently pin an override. */
export function overrideCount() {
  return overrides.size
}

/**
 * Pin this session to exactly these rule ids. An empty list is a real override
 * that injects nothing, so "pinned to nothing" stays distinguishable from "unset".
 * @returns the stored override, or null when the id is unusable.
 */
export function setOverride(sessionId, ruleIds) {
  const id = usableId(sessionId)
  if (id === undefined) return null
  const kept = []
  for (const item of Array.isArray(ruleIds) ? ruleIds : []) {
    const ruleId = usableId(item)
    if (ruleId !== undefined && !kept.includes(ruleId)) kept.push(ruleId)
  }
  overrides.set(id, { ruleIds: kept })
  return { ruleIds: kept.slice() }
}

/** @returns whether an override was there to clear. */
export function clearOverride(sessionId) {
  const id = usableId(sessionId)
  return id === undefined ? false : overrides.delete(id)
}

/** Drop every override; the suites use it to start from a clean board. */
export function clearAllOverrides() {
  overrides.clear()
}
