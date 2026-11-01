// The person's terminal on the side of a channel. The shell lives in the core and goes on when this
// closes: opening again brings back what it printed.
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { L } from '../../../shared/lang'
import { onTerminal, terminalClose, terminalInput, terminalOpen, terminalResize, toggleTerminal } from '../store'
import { Icon } from './ui'

export function TerminalSide({ channelId }: { channelId: string }): ReactNode {
  const host = useRef<HTMLDivElement>(null)
  const [run, setRun] = useState(0) // a new shell, after the last one ended
  const [ended, setEnded] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!host.current) return
    const term = new Terminal({ cursorBlink: true, fontSize: 13, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', scrollback: 5000, theme: { background: '#1c1b19', foreground: '#e8e3da' } })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host.current)
    fit.fit()
    let opened = false
    const pending: string[] = [] // what arrives while the answer with the earlier output is on its way
    const off = onTerminal((e) => {
      if (e.channelId !== channelId) return
      if (e.type === 'terminal_exit') return setEnded(true)
      if (opened) term.write(e.data)
      else pending.push(e.data)
    })
    term.onResize(({ cols, rows }) => terminalResize(channelId, cols, rows))
    const seen = new ResizeObserver(() => fit.fit())
    seen.observe(host.current)
    terminalOpen(channelId, term.cols, term.rows).then(
      ({ output }) => {
        // The earlier output already holds what arrived meanwhile only when the shell was running.
        // Input only after the old output is on screen: xterm answers the queries in it, and those
        // answers would land in the shell as if typed.
        const listen = (): void => void term.onData((data) => terminalInput(channelId, data))
        const earlier = output || pending.join('')
        if (earlier) term.write(earlier, listen)
        else listen()
        opened = true
        term.focus()
      },
      (e: unknown) => setError(e instanceof Error ? e.message.replace(/^Error invoking.*?: /, '') : String(e))
    )
    return () => {
      off()
      seen.disconnect()
      term.dispose()
    }
  }, [channelId, run])

  return (
    <aside className="side-panel terminal-panel">
      <header className="side-panel__head">
        <Icon name="terminal" size={14} />
        <strong className="side-panel__title">{L('Terminal', 'Terminal')}</strong>
        <span className="muted small">{L('o seu, neste computador', 'yours, on this computer')}</span>
        <span className="grow" />
        <button className="btn btn--xs" title={L('Encerra o shell e o que estiver rodando nele', 'Ends the shell and whatever is running in it')} onClick={() => (terminalClose(channelId), setEnded(true))}>
          {L('Encerrar', 'End')}
        </button>
        <button className="icon-btn" title={L('Fechar o painel: o shell continua', 'Close the panel: the shell goes on')} onClick={toggleTerminal}>
          <Icon name="x" size={14} />
        </button>
      </header>
      {error && <div className="note note--error">{error}</div>}
      {ended && (
        <div className="terminal-panel__ended small">
          {L('O shell terminou.', 'The shell ended.')}
          <button className="btn btn--xs" onClick={() => (setEnded(false), setRun((n) => n + 1))}>
            {L('Abrir outro', 'Open another')}
          </button>
        </div>
      )}
      <div className="terminal-panel__screen" ref={host} />
    </aside>
  )
}
