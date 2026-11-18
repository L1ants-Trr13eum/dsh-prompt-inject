/** Entry point of `node test/*.mjs`: each module runs its own suite in turn. */
import { main as dryRunSuite } from './assemble-dry-run.mjs'
import { main as storeSuite } from './config-store.test.mjs'
import { main as matchSuite } from './match.test.mjs'
import { main as routesSuite } from './routes.test.mjs'
import { main as sessionSuite } from './session-override.test.mjs'

await matchSuite()
await storeSuite()
await routesSuite()
await sessionSuite()
await dryRunSuite()
console.log('ALL TESTS PASSED')
