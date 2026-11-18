/**
 * Tiny test harness: one case list per suite, cases run in declaration order,
 * every case runs even after a failure, and any failure sets a non-zero exit code.
 */
import { pathToFileURL } from 'node:url'

/** Assert JSON equality. */
export function eq(actual, expected, label = 'value') {
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) throw new Error(label + ': expected ' + e + ', received ' + a)
}

/** Assert truthiness, keeping the actual value in the message. */
export function ok(value, label = 'condition') {
  if (!value) throw new Error(label + ': expected truthy, received ' + JSON.stringify(value))
}

/** Assert that the call throws, and return the error. */
export function throws(fn, label = 'call') {
  try {
    fn()
  } catch (error) {
    return error
  }
  throw new Error(label + ': expected a throw, none happened')
}

/** @returns whether this module is the process entry point. */
export function isMain(moduleUrl) {
  const entry = process.argv[1]
  if (entry === undefined) return false
  try {
    return pathToFileURL(entry).href.toLowerCase() === moduleUrl.toLowerCase()
  } catch {
    return false
  }
}

/** @returns a case list with its own runner, so suites never see each other's cases. */
export function suite(label) {
  const cases = []
  return {
    test(name, fn) {
      cases.push({ name, fn })
    },
    async run() {
      const failures = []
      let passed = 0
      for (const entry of cases) {
        try {
          await entry.fn()
          passed += 1
          console.log('  ok   ' + entry.name)
        } catch (error) {
          failures.push(entry)
          console.log('  FAIL ' + entry.name + '\n       ' + (error?.message ?? error))
        }
      }
      console.log(label + ': ' + passed + '/' + cases.length + ' passed')
      if (failures.length > 0) {
        process.exitCode = 1
        throw new Error(label + ': ' + failures.length + ' case(s) failed')
      }
    },
  }
}
