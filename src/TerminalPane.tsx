import { useEffect, useRef, useState } from 'react'
import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import { invoke } from './bridge'
import { useBoardRuntime } from './BoardRuntime'

export function TerminalPane({ id }: { id: string }) {
  const element = useRef<HTMLDivElement>(null)
  const terminal = useRef<Terminal | null>(null)
  const fit = useRef<FitAddon | null>(null)
  const runtime = useBoardRuntime()
  const { getOutput } = runtime
  const status = runtime.statuses[id] ?? 'stopped'
  const statusRef = useRef(status)
  const receivedOutput = useRef(false)
  const [hasOutput, setHasOutput] = useState(false)
  statusRef.current = status

  useEffect(() => {
    if (!element.current) return
    const fitAddon = new FitAddon()
    const term = new Terminal({
      cursorBlink: true,
      convertEol: false,
      fontFamily: '"IBM Plex Mono", "Cascadia Code", "Fira Code", monospace',
      fontSize: 12,
      lineHeight: 1.35,
      scrollback: 2000,
      theme: {
        background: '#101114',
        foreground: '#d5d6d8',
        cursor: '#ff7a47',
        selectionBackground: '#4d3c35',
        black: '#17181b',
        red: '#f07470',
        green: '#80c991',
        yellow: '#e9bd73',
        blue: '#83a9e8',
        magenta: '#c8a2df',
        cyan: '#7fc5ca',
        white: '#d6d5d2',
      },
    })
    term.loadAddon(fitAddon)
    term.open(element.current)
    terminal.current = term
    fit.current = fitAddon
    const replay = getOutput(id)
    if (replay) {
      receivedOutput.current = true
      setHasOutput(true)
      term.write(replay)
    }
    requestAnimationFrame(() => fitAddon.fit())

    const input = term.onData((data) => {
      void invoke('write_terminal', { id, data }).catch(() => undefined)
    })
    const observer = new ResizeObserver(() => {
      try {
        fitAddon.fit()
        if (statusRef.current === 'running') {
          void invoke('resize_terminal', { id, cols: term.cols, rows: term.rows }).catch(() => undefined)
        }
      } catch {
        // The node can be between layouts while the board is being restored.
      }
    })
    observer.observe(element.current)

    return () => {
      observer.disconnect()
      input.dispose()
      term.dispose()
      terminal.current = null
      fit.current = null
    }
  }, [getOutput, id])

  useEffect(() => {
    const receive = (event: Event) => {
      const detail = (event as CustomEvent<{ id: string; data: string }>).detail
      if (detail?.id !== id) return
      if (!receivedOutput.current) {
        receivedOutput.current = true
        setHasOutput(true)
      }
      terminal.current?.write(detail.data)
    }
    window.addEventListener('megavibe:terminal-output', receive)
    return () => window.removeEventListener('megavibe:terminal-output', receive)
  }, [id])

  useEffect(() => {
    if (status === 'running' && terminal.current && fit.current) {
      requestAnimationFrame(() => {
        try {
          fit.current?.fit()
          if (terminal.current) {
            void invoke('resize_terminal', {
              id,
              cols: terminal.current.cols,
              rows: terminal.current.rows,
            }).catch(() => undefined)
          }
        } catch {
          // Ignore transient zero-sized layouts.
        }
      })
    }
  }, [id, status])

  return (
    <div className={`terminal-pane ${status === 'running' || hasOutput ? 'is-live' : ''}`}>
      <div className="terminal-hint" hidden={status === 'running' || status === 'starting' || hasOutput}>
        <span className="terminal-hint-mark">›_</span>
        <span>Start this console to open a local PTY</span>
      </div>
      <div className="terminal-screen" ref={element} />
    </div>
  )
}
