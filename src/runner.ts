import * as vscode from 'vscode'
import { spawn } from 'child_process'
import * as readline from 'readline'
import * as config from './config'
import * as cache from './cache'
import * as path from 'path'
import { Report } from './types'
import { Log } from './log'

const MAGIC = '[VSCODE-BUSTED-REPORT]'

// ---------- Helpers ---------- //
function quoteIfWindows (s: string): string {
  if (process.platform !== 'win32') return s
  if (/^".*"$/.test(s)) return s
  return `"${s.replace(/"/g, '\\"')}"`
}

function withIdleWatchdog (child: ReturnType<typeof spawn>, ms: number, onTimeout: () => void) {
  let last = Date.now()
  const bump = () => { last = Date.now() }
  const timer = setInterval(() => {
    if (Date.now() - last > ms) {
      onTimeout()
      try { child.kill() } catch { }
      clearInterval(timer)
    }
  }, 1000)

  child.stdout?.on('data', bump)
  child.stderr?.on('data', bump)
  child.on('close', () => clearInterval(timer))
}

// ---------- Test Error Formatting ---------- //
function getErrorMessage (test: vscode.TestItem, report: Report) {
  if (report.message) {
    const diff = report.message.match(/[^:]*: (?<msg>.*)\nPassed in:\n(?<actual>.*)\nExpected:\n(?<expected>.*)/)
    let message
    if (diff && diff.groups) {
      message = vscode.TestMessage.diff(diff.groups.msg, diff.groups.expected, diff.groups.actual)
    } else {
      message = new vscode.TestMessage(report.message)
    }

    if (test.uri && report.line) {
      message.location = new vscode.Location(test.uri, new vscode.Position(report.line - 1, 0))
    }
    return message
  }
  return new vscode.TestMessage('Unknown error')
}

// ---------- Main Execute ---------- //
export async function execute (
  context: vscode.ExtensionContext,
  run: vscode.TestRun,
  files: Set<string>,
  filter: Set<string>,
  filterOut: Set<string>,
  token: vscode.CancellationToken
) {
  const bustedExecutable = config.getExecutable()
  const reporterPath = path.join(context.extensionPath, 'res', 'reporter.lua')

  await new Promise((resolve: Function) => {
    const args = [
      ...[...filter].map(name => `--filter=${quoteIfWindows(name)}`), // NEW quoting
      '-o', reporterPath,
      ...config.getArguments(),
      ...files
    ]

    Log.info(`[Busted] 🔄 execute: ${bustedExecutable} ${args.join(' ')}`)
    console.log('[Busted] 🔄 execute:', bustedExecutable, args)

    const busted = spawn(bustedExecutable, args, {
      cwd: config.getWorkingDirectory(),
      env: { ...process.env, ...config.getEnvironment() },
      shell: process.platform === 'win32',
      windowsVerbatimArguments: process.platform === 'win32'
    })

    // watchdog (from settings)
    const idleMs = vscode.workspace.getConfiguration('busted-test-explorer').get('idleTimeoutMs', 120000)
    withIdleWatchdog(busted, idleMs, () => Log.error(`[Busted] No output for ${idleMs}ms — killing process ❌`))

    const rl = readline.createInterface({ input: busted.stdout })
    let currentTest: vscode.TestItem | undefined

    rl.on('line', (line: string) => {
      if (line.startsWith(MAGIC)) {
        const report = JSON.parse(line.substring(MAGIC.length + 1))
        const test = cache.getTest(report.test)
        switch (report.type) {
          case 'testStart':
            run.appendOutput(`[Busted] ▶ Run test: ${report.test}\r\n`)
            if (test) {
              run.started(test)
              currentTest = test
            }
            break
          case 'testEnd':
            run.appendOutput(`[Busted] ⏹ End test: ${report.test} (${report.status})\r\n`)
            currentTest = undefined
            if (test) {
              switch (report.status) {
                case 'success': run.passed(test, report.duration); break
                case 'failure': run.failed(test, getErrorMessage(test, report), report.duration); break
                case 'pending': run.skipped(test); break
                case 'error': run.errored(test, getErrorMessage(test, report), report.duration); break
              }
            }
            break
          case 'error':
            run.appendOutput('[Busted] ⚠ error: ' + report.message.replace(/([^\r])\n/g, '$1\r\n') + '\r\n', undefined, currentTest)
            Log.error(`[Busted] 💥 error: ${report.message}`)
            break
          default:
            console.log('[Busted] ⚠ unknown report type:', report.type)
            Log.debug(`[Busted] ⚠ unknown report type: ${report.type}`)
            break
        }
      } else {
        run.appendOutput(line + '\r\n', undefined, currentTest)
      }
    })

    busted.stderr.on('data', data => {
      const s = data.toString()
      Log.error(`[Busted] 💥 stderr: ${s}`)
      run.appendOutput(`[Busted] ⚠ stderr: ${s}\r\n`, undefined, currentTest)
      console.log(`[Busted] stderr: ${data}`)
    })
    busted.on('error', (error) => {
      Log.error(`[Busted] 💥 spawn error: ${error.message}\r\nCheck that '${bustedExecutable}' is installed and in your PATH`)
      run.appendOutput(`[Busted] ⚠ error: ${error.message}\r\n`, undefined, currentTest)
      console.log(`[Busted] error: ${error.message}`)
      vscode.window.showErrorMessage(`[Busted] Failed to spawn busted: (${error.message})`)
    })
    busted.on('close', (code) => {
      const msg : string = code === 0
        ? '[Busted] ✅ Finished successfully'
        : `[Busted] ❌ Failed with exit code ${code}`

      Log.info(msg)
      run.appendOutput(`${msg}\r\n`, undefined, currentTest)
      console.log(`[Busted] close: ${code}`)
      resolve(code ?? 1)
    })

    token.onCancellationRequested(() => {
      busted.kill()
    })
  })

  run.end()
}
