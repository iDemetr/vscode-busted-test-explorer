import * as vscode from 'vscode'

export type LogLevel = 'off' | 'info' | 'debug';

// ---------- Logger ---------- //
export class Logger {
  private static ch = vscode.window.createOutputChannel('Busted Test Explorer')

  private static level (): LogLevel {
    const v = vscode.workspace.getConfiguration('busted-test-explorer').get<string>('logLevel', 'info')
    return (['off', 'info', 'debug'] as const).includes(v as LogLevel)
      ? (v as LogLevel)
      : 'info'
  }

  static show () { this.ch.show(true) }

  static info (msg: string) {
    if (this.level() !== 'off') { this.ch.appendLine(`[INFO  ${new Date().toISOString()}] ${msg}`) }
  }

  static debug (msg: string) {
    this.developerLog(msg)
    if (this.level() === 'debug') { this.ch.appendLine(`[DEBUG ${new Date().toISOString()}] ${msg}`) }
  }

  static error (msg: string) {
    this.developerLog(msg)
    this.ch.appendLine(`[ERROR ${new Date().toISOString()}] ${msg}`)
  }

  static developerLog (msg: string, ...optionalParams: any[]) {
    console.log(msg, optionalParams)
  }
}
