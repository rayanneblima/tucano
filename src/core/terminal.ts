// The person's own terminal, on the side of a channel: it starts in the home folder and reaches
// what any terminal on this computer reaches, so it never runs for an agent or holds a channel's keys.
// node-pty is optional and loaded only when asked: without it, the rest of the app doesn't notice.
import { L } from '../shared/lang'
import type { CoreEvent } from '../shared/rpc'

const SCROLLBACK = 200_000 // what comes back when the panel opens again

interface Pty {
  onData(cb: (data: string) => void): unknown
  onExit(cb: () => void): unknown
  write(data: string): void
  resize(cols: number, rows: number): void
  kill(): void
}
type Spawn = (file: string, args: string[], options: { name: string; cols: number; rows: number; cwd: string; env: Record<string, string> }) => Pty

export interface TerminalDeps {
  emit: (e: CoreEvent) => void
  env: () => Promise<NodeJS.ProcessEnv>
  shell: () => string
  cwd: (channelId: string) => string
  allowed: boolean // not on a server: this would be a shell for whoever opens the page
  load?: () => Promise<Spawn>
}

const loadPty = async (): Promise<Spawn> => (await import('node-pty')).spawn as unknown as Spawn

export class Terminals {
  private live = new Map<string, { pty: Pty; output: string }>()
  private opening = new Map<string, Promise<void>>() // asked twice at once, one shell
  private dropped = new Set<string>() // closed while still opening

  constructor(private deps: TerminalDeps) {}

  async open(channelId: string, cols: number, rows: number): Promise<{ output: string }> {
    if (!this.deps.allowed) throw new Error(L('O terminal não existe no Tucano em servidor.', "The terminal doesn't exist on Tucano as a server."))
    const running = this.live.get(channelId)
    if (running) {
      running.pty.resize(cols, rows)
      return { output: running.output }
    }
    let starting = this.opening.get(channelId)
    if (!starting) {
      starting = this.start(channelId, cols, rows).finally(() => {
        this.opening.delete(channelId)
        this.dropped.delete(channelId)
      })
      this.opening.set(channelId, starting)
    }
    await starting
    return { output: this.live.get(channelId)?.output ?? '' }
  }

  private async start(channelId: string, cols: number, rows: number): Promise<void> {
    let spawn: Spawn
    try {
      spawn = await (this.deps.load ?? loadPty)()
    } catch {
      throw new Error(L('O componente do terminal não está disponível neste computador.', "The terminal's component isn't available on this computer."))
    }
    const env = Object.fromEntries(Object.entries({ ...(await this.deps.env()), TERM: 'xterm-256color', COLORTERM: 'truecolor' }).filter((e): e is [string, string] => typeof e[1] === 'string'))
    if (this.dropped.has(channelId)) return
    const pty = spawn(this.deps.shell(), [], { name: 'xterm-256color', cols, rows, cwd: this.deps.cwd(channelId), env })
    const entry = { pty, output: '' }
    this.live.set(channelId, entry)
    pty.onData((data) => {
      if (this.live.get(channelId) !== entry) return
      entry.output += data
      if (entry.output.length > 2 * SCROLLBACK) entry.output = entry.output.slice(-SCROLLBACK) // not at every chunk
      this.deps.emit({ type: 'terminal', channelId, data })
    })
    pty.onExit(() => {
      if (this.live.get(channelId) !== entry) return
      this.live.delete(channelId)
      this.deps.emit({ type: 'terminal_exit', channelId })
    })
  }

  input(channelId: string, data: string): void {
    this.live.get(channelId)?.pty.write(data)
  }

  resize(channelId: string, cols: number, rows: number): void {
    if (cols > 0 && rows > 0) this.live.get(channelId)?.pty.resize(cols, rows)
  }

  close(channelId: string): void {
    if (this.opening.has(channelId)) this.dropped.add(channelId)
    const entry = this.live.get(channelId)
    if (!entry) return
    this.live.delete(channelId)
    entry.pty.kill()
  }

  closeAll(): void {
    for (const id of new Set([...this.live.keys(), ...this.opening.keys()])) this.close(id)
  }
}
