#!/usr/bin/env node
// research-run: run a command on this auto-research worker's committed branch
// head through the batch executor (a Colab GPU or a LayerFS Sandbox).
//
//   node "$DSH_AUTO_RESEARCH_RUN" [--timeout <seconds>] -- <command> [args...]
//
// Prints the command's stdout and stderr and exits with its exit code
// (124 when it ran out of time). Commit before running: only committed files
// are there.

const args = process.argv.slice(2)
let timeout = 300
while (args.length > 0 && args[0] !== '--') {
  const flag = args.shift()
  if (flag === '--timeout') timeout = Number(args.shift())
  else {
    process.stderr.write(`research-run: unknown option ${flag}\n`)
    process.exit(2)
  }
}
if (args[0] === '--') args.shift()
const url = process.env.DSH_AUTO_RESEARCH_URL
const token = process.env.DSH_AUTO_RESEARCH_TOKEN
if (!url || !token) {
  process.stderr.write('research-run: not inside a running auto-research worker\n')
  process.exit(2)
}
if (args.length === 0 || !(timeout > 0)) {
  process.stderr.write('usage: node "$DSH_AUTO_RESEARCH_RUN" [--timeout <seconds>] -- <command> [args...]\n')
  process.exit(2)
}
const response = await fetch(url, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ argv: args, timeout }),
  signal: AbortSignal.timeout((timeout + 1800) * 1000),
})
const result = await response.json()
if (!response.ok) {
  process.stderr.write(`research-run: ${result.error ?? response.status}\n`)
  process.exit(2)
}
process.stderr.write(`[research-run] ${result.environment} @ ${String(result.commit).slice(0, 12)}${result.timedOut ? ' (timed out)' : ''}\n`)
process.stdout.write(result.stdout ?? '')
process.stderr.write(result.stderr ?? '')
process.exit(result.timedOut ? 124 : result.code ?? 1)
