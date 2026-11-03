#!/usr/bin/env node
/**
 * Command-line bridge for `dsh-auto-research/colab` (`dsh-colab`).
 *
 * Subcommands:
 * - `health`: Query the remote Colab GPU server status and queue depth.
 * - `exec [--timeout <sec>] [--cold-l2-flush] [workspace] -- <cmd...>`: Sync `workspace` to Colab and run `<cmd...>` on the GPU queue.
 * - `bootstrap [--port 8765] [--tunnel cloudflared|ngrok|none]`: Print the 1-cell Colab Notebook setup code.
 */

import * as fs from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ColabClient } from './client.js'
import { buildColabBootstrapCell } from './server-script.js'

function parsePositiveSeconds(raw: string | undefined, label: string): number {
  const num = Number(raw)
  if (!Number.isFinite(num) || num <= 0) {
    throw new Error(`${label} must be a positive finite number (got ${String(raw)})`)
  }
  return num
}

export async function runColabCli(
  argv: string[],
  env: NodeJS.ProcessEnv = process.env,
  streams: {
    stdout: { write: (chunk: string) => unknown }
    stderr: { write: (chunk: string) => unknown }
  } = { stdout: process.stdout, stderr: process.stderr },
): Promise<number> {
  const args = [...argv]
  const subcommand = args.shift() ?? 'help'

  try {
    if (subcommand === 'bootstrap') {
      let port = 8765
      let tunnel: 'cloudflared' | 'ngrok' | 'none' = 'cloudflared'
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i]
        if (arg === '--port') {
          const next = args[i + 1]
          const parsedPort = Number(next)
          if (!next || !Number.isInteger(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
            throw new Error(`Invalid --port value: ${String(next)} (expected integer 1..65535)`)
          }
          port = parsedPort
          i += 1
        } else if (arg === '--tunnel') {
          const val = args[i + 1]
          if (val !== 'cloudflared' && val !== 'ngrok' && val !== 'none') {
            throw new Error(`Invalid --tunnel value: ${String(val)} (expected cloudflared, ngrok, or none)`)
          }
          tunnel = val
          i += 1
        }
      }
      streams.stdout.write(buildColabBootstrapCell({ port, tunnel }) + '\n')
      return 0
    }

    if (subcommand === 'health') {
      const client = new ColabClient(undefined, env)
      const health = await client.health()
      streams.stdout.write(JSON.stringify(health, null, 2) + '\n')
      return health.ok ? 0 : 1
    }

    if (subcommand === 'exec') {
      const sepIndex = args.indexOf('--')
      const preArgs = sepIndex === -1 ? [] : args.slice(0, sepIndex)
      let command = sepIndex === -1 ? [...args] : args.slice(sepIndex + 1)

      let workspace = process.cwd()
      let timeoutSeconds: number | undefined
      let coldL2Flush = false

      if (sepIndex !== -1) {
        const positional: string[] = []
        for (let i = 0; i < preArgs.length; i += 1) {
          const flag = preArgs[i]
          if (flag === '--timeout') {
            timeoutSeconds = parsePositiveSeconds(preArgs[i + 1], '--timeout')
            i += 1
          } else if (flag === '--cold-l2-flush') {
            coldL2Flush = true
          } else if (flag) {
            positional.push(flag)
          }
        }
        if (positional[0]) workspace = resolve(positional[0])
      } else {
        while (command.length > 0 && command[0]?.startsWith('--')) {
          const flag = command.shift()
          if (flag === '--timeout') {
            timeoutSeconds = parsePositiveSeconds(command.shift(), '--timeout')
          } else if (flag === '--cold-l2-flush') {
            coldL2Flush = true
          }
        }
      }

      if (command.length === 0) {
        streams.stderr.write('Usage: dsh-colab exec [--timeout <sec>] [--cold-l2-flush] [workspace] -- <command...>\n')
        return 2
      }
      const client = new ColabClient(undefined, env)
      const result = await client.exec(workspace, command, {
        ...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
        ...(coldL2Flush ? { coldL2Flush: true } : {}),
      })
      if (result.stdout) streams.stdout.write(result.stdout)
      if (result.stderr) streams.stderr.write(result.stderr)
      if (result.timed_out) {
        streams.stderr.write('\n[dsh-colab] Remote command timed out on Colab GPU queue\n')
        return 124
      }
      return result.exit_code ?? 1
    }

    streams.stdout.write(
      [
        'dsh-auto-research Colab GPU CLI',
        '',
        'Commands:',
        '  health                             Check Colab GPU status and queue depth',
        '  exec [workspace] -- <command...>   Run a command in an isolated Colab GPU workspace',
        '  bootstrap [--port N] [--tunnel T]  Print the 1-cell Google Colab Notebook setup script',
      ].join('\n') + '\n',
    )
    return subcommand === 'help' || subcommand === '--help' || subcommand === '-h' ? 0 : 2
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    streams.stderr.write(`[dsh-colab] Error: ${message}\n`)
    return 1
  }
}

function isExecutedDirectly(): boolean {
  const argv1 = process.argv[1]
  if (!argv1) return false
  const selfPath = fileURLToPath(import.meta.url)
  try {
    return fs.realpathSync(argv1) === fs.realpathSync(selfPath)
  } catch {
    return resolve(argv1) === resolve(selfPath)
  }
}

if (isExecutedDirectly()) {
  void runColabCli(process.argv.slice(2)).then(code => {
    process.exitCode = code
  })
}
