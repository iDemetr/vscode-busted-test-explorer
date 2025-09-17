import * as vscode from 'vscode'
import { spawn } from 'child_process'
import * as readline from 'readline'
import * as config from './config'
import * as cache from './cache'
import * as path from 'path'
import { Report } from './types'
import { Logger } from './log'

const MAGIC = '[VSCODE-BUSTED-REPORT]'

// ---------- Helpers ---------- //
function quoteIfWindows (s: string): string {
  if (process.platform !== 'win32') return s
  if (/^".*"$/.test(s)) return s
  return `"${s.replace(/"/g, '\\"')}"`
}

// It starts a timer to catch "hung" tests that do not allow the GUI to unlock due to endless waiting.
function withIdleWatchdog (
  child: ReturnType<typeof spawn>,
  ms: number, run: vscode.TestRun,
  currentTest: vscode.TestItem | undefined
): void {
  let last = Date.now()
  const bump = () => { last = Date.now() }

  // при любом приходе stdout/stderr — обновляем last
  child.stdout?.on('data', (_d) => bump())
  child.stderr?.on('data', (_d) => bump())
  child.on('close', () => clearInterval(timer))
  child.on('error', () => clearInterval(timer))

  const timer = setInterval(() => {
    try {
      if (Date.now() - last > ms) {
        const msg = `[Busted] ⏱ No output for ${ms}ms — killing process ❌`
        // логим в run (Output панели)
        try {
          run.appendOutput(msg + '\r\n', undefined, currentTest)
        } catch {
          // на всякий случай — в случае, если run.appendOutput недоступен
        }

        // если есть активный testItem — помечаем его как errored
        if (currentTest) {
          const message = new vscode.TestMessage(msg)
          try { run.errored(currentTest, message) } catch (e) { /* ignore */ }
        }

        // kill process
        try {
          child.kill()
        } catch (e) {
          // Log.log(e)
        }
        clearInterval(timer)
      }
    } catch (err) {
      // защищаемся от неожиданных ошибок внутри таймера
      try { run.appendOutput(`Watchdog error: ${String(err)}\r\n`) } catch { }
      clearInterval(timer)
    }
  }, 1000)
}

// Forms the path to the performer, depending on the selected profile
function getExecutable (profile : string) : string {
  let bustedExecutable: string
  if (profile === 'wsl') {
    bustedExecutable = vscode.workspace.getConfiguration('busted-test-explorer').get<string>('wslExecutable', 'wsl busted')
  } else if (profile === 'docker') {
    bustedExecutable = vscode.workspace.getConfiguration('busted-test-explorer').get<string>('dockerExecutable', 'docker run --rm my-lua busted')
  } else {
    bustedExecutable = config.getExecutable() // default path (bat/exe)
  }

  Logger.developerLog('[Busted] 🚀 Profile:', profile)
  Logger.info(`[Busted] 🚀 Using profile: ${profile}`)

  return bustedExecutable
}

// Transmits messages to a special tab with test results.
function resultConcole (run: vscode.TestRun, msg : string, location?: vscode.Location, test?:vscode.TestItem) {
  run.appendOutput(msg + '\r\n', location, test)
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
  // --- profile support ---
  const profile = vscode.workspace.getConfiguration('busted-test-explorer').get<string>('profile', 'local')

  const bustedExecutable = getExecutable(profile)
  const reporterPath = path.join(context.extensionPath, 'res', 'reporter.lua')

  await new Promise((resolve: Function) => {
    const args = [
      ...[...filter].map(name => `--filter=${quoteIfWindows(name)}`), // NEW quoting
      '-o', reporterPath,
      ...config.getArguments(),
      ...files
    ]

    Logger.developerLog('[Busted] 🔄 Executable:', bustedExecutable, args)
    Logger.info(`[Busted] 🔄 Executable: ${bustedExecutable} \nArgs:\n ${args.join('\n ')}`)

    const busted = spawn(bustedExecutable, args, {
      cwd: config.getWorkingDirectory(),
      env: { ...process.env, ...config.getEnvironment() },
      shell: process.platform === 'win32',
      windowsVerbatimArguments: process.platform === 'win32'
    })

    let cntSuccessTests: number = 0
    let cntFailTests: number = 0
    let currentTest: vscode.TestItem | undefined

    // watchdog (from settings)
    const idleMs = vscode.workspace.getConfiguration('busted-test-explorer').get('idleTimeoutMs', 120000)
    withIdleWatchdog(busted, idleMs, run, currentTest)

    const rl = readline.createInterface({ input: busted.stdout })

    rl.on('line', (line: string) => {
      if (line.startsWith(MAGIC)) {
        const report = JSON.parse(line.substring(MAGIC.length + 1))
        const test = cache.getTest(report.test)
        const testName = report.test.split('\\').pop()

        switch (report.type) {
          case 'testStart':
            resultConcole(run, `[Busted] ▶ Run: ${testName}`)
            if (test) {
              run.started(test)
              currentTest = test
            }
            break
          case 'testEnd':
            resultConcole(run, `[Busted] ⏹ End: ${testName} (${report.status})`)
            currentTest = undefined
            if (test) {
              switch (report.status) {
                case 'success': run.passed(test, report.duration); cntSuccessTests++; break
                case 'failure': run.failed(test, getErrorMessage(test, report), report.duration); cntFailTests++; break
                case 'pending': run.skipped(test); break
                case 'error': run.errored(test, getErrorMessage(test, report), report.duration); cntFailTests++; break
              }
            }
            break
          case 'error': {
            cntFailTests++;
            const mgs = `[Busted] 💥 error: ${report.message.replace('/([^\r])\n/g', '$1\r\n')}\r\n`
            resultConcole(run, mgs, undefined, currentTest)
            Logger.error(`[Busted] 💥 error: ${report.message}`)
            break
          }
          default: {
            cntFailTests++;
            const msg = '[Busted] ⚠ unknown report type:'
            Logger.developerLog(msg, report.type)
            Logger.debug(msg + report.type)
            break
          }
        }
      } else {
        resultConcole(run, line, undefined, currentTest)
        Logger.debug(line)
      }
    })

    busted.stderr.on('data', data => {
      const s = data.toString()
      resultConcole(run, `[Busted] ⚠ stderr: ${s}`, undefined, currentTest)
      Logger.error(`[Busted] 💥 stderr: ${s}`)
    })

    busted.on('error', (error) => {
      resultConcole(run, `[Busted] ⚠ error: ${error.message}`, undefined, currentTest)
      Logger.error(`[Busted] 💥 spawn error: ${error.message}\r\nCheck that '${bustedExecutable}' is installed and in your PATH`)
      vscode.window.showErrorMessage(`[Busted] Failed to spawn busted: (${error.message})`)
    })

    busted.on('close', (code) => {
      const msg: string = code === 0
        ? '[Busted] ✅ Finished successfully'
        : `[Busted] ❌ Failed with exit code ${code}`
      const statistics: string = `with success: ${cntSuccessTests} and fails: ${cntFailTests}`

      resultConcole(run, `${msg} ${statistics}`, undefined, currentTest)
      Logger.info(msg)
      Logger.developerLog(`[Busted] close: ${code}`)
      resolve(code ?? 1)
    })

    token.onCancellationRequested(() => {
      busted.kill()
    })
  })

  run.end()
}
