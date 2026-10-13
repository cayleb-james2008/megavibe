import { useEffect, useRef, useState } from 'react'
import { Handle, Position, type NodeProps } from '@xyflow/react'
import { getResumeArgs, type BoardItem, type BoardItemData } from './model'
import { useBoardRuntime } from './BoardRuntime'
import { TerminalPane } from './TerminalPane'
import { inDesktopApp, invoke } from './bridge'

function safeWebUrl(value: string) {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : ''
  } catch {
    return ''
  }
}

export function BoardCard({ id, data, selected }: NodeProps<BoardItem>) {
  const runtime = useBoardRuntime()
  const [draftItem, setDraftItem] = useState('')
  const [draftEvent, setDraftEvent] = useState('')
  const [eventDate, setEventDate] = useState(() => new Date().toISOString().slice(0, 10))
  const [drawing, setDrawing] = useState<Array<{ x: number; y: number }> | null>(null)
  const [gitStatus, setGitStatus] = useState('')
  const [gitError, setGitError] = useState('')
  const drawingRef = useRef<SVGSVGElement>(null)
  const status = runtime.statuses[id] ?? 'stopped'
  const patch = (values: Partial<BoardItemData>) => runtime.updateNode(id, (current: BoardItemData) => ({ ...current, ...values }))

  useEffect(() => {
    if (data.kind !== 'git' || !runtime.workspacePath || !inDesktopApp) return
    let cancelled = false
    const refresh = async () => {
      try {
        const statusText = await invoke<string>('git_status', { path: runtime.workspacePath })
        if (!cancelled) { setGitStatus(statusText); setGitError('') }
      } catch (error) {
        if (!cancelled) setGitError(String(error))
      }
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 30_000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [data.kind, runtime.workspacePath])

  return (
    <article className={`board-card card-${data.kind} ${selected ? 'is-selected' : ''}`}>
      <Handle type="target" position={Position.Left} className="flow-handle" />
      <header className="card-topbar">
        <span className={`card-kind-icon kind-${data.kind}`}>{data.kind === 'terminal' ? '⌘' : data.kind === 'note' || data.kind === 'text' ? '✎' : data.kind === 'checklist' ? '☑' : data.kind === 'kanban' ? '▦' : data.kind === 'calendar' ? '▣' : data.kind === 'drawing' ? '✳' : data.kind === 'image' ? '▧' : data.kind === 'code' ? '</>' : data.kind === 'diagram' ? '⌘' : data.kind === 'git' ? '⑂' : '↗'}</span>
        <input
          className="card-title nodrag"
          value={data.title}
          aria-label="Card title"
          onChange={(event) => patch({ title: event.target.value })}
        />
        {data.kind === 'terminal' && <span className={`live-indicator ${status}`}>{status === 'running' ? 'LIVE' : status === 'starting' ? 'STARTING' : status === 'stopping' ? 'STOPPING' : status === 'error' ? 'ERROR' : 'IDLE'}</span>}
        <button className="icon-button nodrag" aria-label="Remove card" title="Remove from board" disabled={status === 'starting' || status === 'stopping'} onClick={() => runtime.removeNode(id)}>×</button>
      </header>

      {data.kind === 'terminal' && (
        <>
          <div className="terminal-meta nodrag">
            <button className="command-chip" title="Edit command" onClick={() => runtime.editTerminal(id)}>
              <span className="command-dot" />
              <span>{data.command || 'bash'}{data.args?.length ? ` · ${data.args.length} args` : ''}</span>
              <span className="edit-glyph">⌄</span>
            </button>
            <span className="cwd-label" title={data.cwd || 'Home directory'}>{data.cwd?.split('/').filter(Boolean).slice(-2).join('/') || '~'}</span>
          </div>
          <TerminalPane id={id} />
          {runtime.messages[id] && <div className="card-error nodrag">{runtime.messages[id]}</div>}
          <footer className="card-actions nodrag">
            {status === 'running' || status === 'stopping'
              ? <button className="button button-stop" onClick={() => runtime.stopTerminal(id)} disabled={status === 'stopping'}>{status === 'stopping' ? 'Stopping…' : 'Stop console'}</button>
              : <button className="button button-run" onClick={() => runtime.startTerminal(id)} disabled={status === 'starting'}>{status === 'starting' ? 'Starting…' : 'Run console'} <span>↗</span></button>}
            {status !== 'running' && status !== 'stopping' && getResumeArgs(data.command ?? '', data.resumeArgs, data.sessionId) && <button className="text-button" onClick={() => runtime.startTerminal(id, true)} disabled={status === 'starting'}>Resume CLI session</button>}
            {status === 'running' && <button className="text-button" onClick={() => runtime.prepareHandoff(id)}>Handoff ↗</button>}
            <span className="card-footnote">local process · no remote relay</span>
          </footer>
        </>
      )}

      {(data.kind === 'note' || data.kind === 'text') && (
        <div className="note-editor nodrag">
          <textarea value={data.content ?? ''} aria-label="Note content" placeholder="Write a note…" onChange={(event) => patch({ content: event.target.value })} />
          <div className="editor-foot"><span>Markdown friendly</span><span>Saved locally</span></div>
        </div>
      )}

      {data.kind === 'checklist' && (
        <div className="checklist-editor nodrag">
          {(data.items ?? []).map((item) => (
            <div className={`check-row ${item.done ? 'checked' : ''}`} key={item.id}>
              <input type="checkbox" checked={item.done} aria-label={`Complete ${item.text}`} onChange={(event) => patch({ items: (data.items ?? []).map((row) => row.id === item.id ? { ...row, done: event.target.checked } : row) })} />
              <input value={item.text} aria-label="Checklist item" onChange={(event) => patch({ items: (data.items ?? []).map((row) => row.id === item.id ? { ...row, text: event.target.value } : row) })} />
              <button className="remove-item" aria-label="Remove checklist item" onClick={() => patch({ items: (data.items ?? []).filter((row) => row.id !== item.id) })}>×</button>
            </div>
          ))}
          <form className="checklist-add" onSubmit={(event) => {
            event.preventDefault()
            const text = draftItem.trim()
            if (!text) return
            patch({ items: [...(data.items ?? []), { id: crypto.randomUUID(), text, done: false }] })
            setDraftItem('')
          }}>
            <span>＋</span><input value={draftItem} onChange={(event) => setDraftItem(event.target.value)} placeholder="Add a task" aria-label="Add checklist item" />
          </form>
          <div className="editor-foot"><span>{(data.items ?? []).filter((item) => item.done).length} / {(data.items ?? []).length} complete</span><span>Saved locally</span></div>
        </div>
      )}

      {data.kind === 'kanban' && <div className="kanban-card nodrag">
        <div className="kanban-columns">{(['todo', 'doing', 'done'] as const).map((statusKey) => <section key={statusKey}><h4>{statusKey === 'todo' ? 'To do' : statusKey === 'doing' ? 'In progress' : 'Done'}</h4>{(data.tasks ?? []).filter((task) => task.status === statusKey).map((task) => <article className="kanban-task" key={task.id}><span>{task.text}</span><div><button title="Move left" onClick={() => patch({ tasks: (data.tasks ?? []).map((item) => item.id === task.id ? { ...item, status: item.status === 'done' ? 'doing' : 'todo' } : item) })}>←</button><button title="Move right" onClick={() => patch({ tasks: (data.tasks ?? []).map((item) => item.id === task.id ? { ...item, status: item.status === 'todo' ? 'doing' : 'done' } : item) })}>→</button><button title="Remove task" onClick={() => patch({ tasks: (data.tasks ?? []).filter((item) => item.id !== task.id) })}>×</button></div></article>)}</section>)}</div>
        <form className="checklist-add" onSubmit={(event) => { event.preventDefault(); const text = draftItem.trim(); if (!text) return; patch({ tasks: [...(data.tasks ?? []), { id: crypto.randomUUID(), text, status: 'todo' }] }); setDraftItem('') }}><span>＋</span><input value={draftItem} onChange={(event) => setDraftItem(event.target.value)} aria-label="Add kanban task" placeholder="Add a card" /></form>
      </div>}

      {data.kind === 'calendar' && <div className="calendar-card nodrag">
        <form onSubmit={(event) => { event.preventDefault(); const text = draftEvent.trim(); if (!text) return; patch({ events: [...(data.events ?? []), { id: crypto.randomUUID(), text, date: eventDate }] }); setDraftEvent('') }}><input type="date" aria-label="Event date" value={eventDate} onChange={(event) => setEventDate(event.target.value)} /><input aria-label="Calendar event" placeholder="Add an event" value={draftEvent} onChange={(event) => setDraftEvent(event.target.value)} /><button className="button button-outline">＋</button></form>
        {[...(data.events ?? [])].sort((a, b) => a.date.localeCompare(b.date)).map((item) => <div className="calendar-event" key={item.id}><time>{item.date}</time><span>{item.text}</span><button onClick={() => patch({ events: (data.events ?? []).filter((event) => event.id !== item.id) })} aria-label="Remove event">×</button></div>)}
        {!data.events?.length && <p className="calendar-empty">Add a dated project milestone.</p>}
      </div>}

      {data.kind === 'drawing' && <div className="drawing-card nodrag">
        <div className="drawing-tools"><span>Freehand sketch</span><button className="text-button" onClick={() => patch({ strokes: [] })}>Clear</button></div>
        <svg ref={drawingRef} viewBox="0 0 320 160" onPointerDown={(event) => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); const box = event.currentTarget.getBoundingClientRect(); setDrawing([{ x: ((event.clientX - box.left) / box.width) * 320, y: ((event.clientY - box.top) / box.height) * 160 }]) }} onPointerMove={(event) => { if (!drawing) return; const box = event.currentTarget.getBoundingClientRect(); setDrawing((points) => [...(points ?? []), { x: ((event.clientX - box.left) / box.width) * 320, y: ((event.clientY - box.top) / box.height) * 160 }]) }} onPointerUp={(event) => { if (!drawing) return; event.stopPropagation(); patch({ strokes: [...(data.strokes ?? []), { color: '#f18a5b', points: drawing }] }); setDrawing(null) }} onPointerCancel={() => setDrawing(null)}>
          {(data.strokes ?? []).map((stroke, index) => <polyline key={index} points={stroke.points.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke={stroke.color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />)}
          {drawing && <polyline points={drawing.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke="#f18a5b" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />}
        </svg>
      </div>}

      {data.kind === 'image' && <div className="image-markup-card nodrag"><div className="drawing-tools"><span>Image markup</span><button className="text-button" onClick={() => patch({ strokes: [] })}>Clear marks</button></div>{data.imageData ? <div className="image-markup-stage"><img src={data.imageData} alt={data.title} /><svg ref={drawingRef} viewBox="0 0 320 200" onPointerDown={(event) => { event.stopPropagation(); event.currentTarget.setPointerCapture(event.pointerId); const box = event.currentTarget.getBoundingClientRect(); setDrawing([{ x: ((event.clientX - box.left) / box.width) * 320, y: ((event.clientY - box.top) / box.height) * 200 }]) }} onPointerMove={(event) => { event.stopPropagation(); if (!drawing) return; const box = event.currentTarget.getBoundingClientRect(); setDrawing((points) => [...(points ?? []), { x: ((event.clientX - box.left) / box.width) * 320, y: ((event.clientY - box.top) / box.height) * 200 }]) }} onPointerUp={(event) => { event.stopPropagation(); if (!drawing) return; patch({ strokes: [...(data.strokes ?? []), { color: '#f18a5b', points: drawing }] }); setDrawing(null) }} onPointerCancel={() => setDrawing(null)}>{(data.strokes ?? []).map((stroke, index) => <polyline key={index} points={stroke.points.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke={stroke.color} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />)}{drawing && <polyline points={drawing.map((point) => `${point.x},${point.y}`).join(' ')} fill="none" stroke="#f18a5b" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />}</svg></div> : <div className="preview-empty">Drop an image on the board to add it here.</div>}</div>}

      {data.kind === 'code' && <div className="code-card nodrag"><small>{data.filePath}</small><pre><code>{data.content}</code></pre></div>}
      {data.kind === 'diagram' && <div className="diagram-card nodrag">{data.diagramSvg ? <img alt="Pinned board diagram" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(data.diagramSvg)}`} /> : <p>Diagram source is unavailable.</p>}</div>}

      {data.kind === 'git' && <div className="git-board-card nodrag"><div className="git-board-summary"><strong>{gitStatus.split('\n')[0]?.replace(/^##\s*/, '').split('...')[0] || 'Repository status'}</strong><button className="text-button" onClick={() => runtime.openGit()}>Open Git ↗</button></div>{gitError ? <p className="code-error">{gitError}</p> : !runtime.workspacePath ? <p className="calendar-empty">Open a project to show local Git status.</p> : !gitStatus ? <p className="calendar-empty">Reading local repository…</p> : gitStatus.split('\n').slice(1).filter(Boolean).length ? <ul>{gitStatus.split('\n').slice(1).filter(Boolean).slice(0, 8).map((line, index) => <li key={`${line}-${index}`}><code>{line.slice(3)}</code></li>)}</ul> : <p className="git-clean"><span>✓</span> Working tree clean</p>}<small>Local status refreshes every 30 seconds.</small></div>}

      {data.kind === 'preview' && (
        <div className="preview-card nodrag">
          <div className="preview-address"><span>⌕</span><input value={data.url ?? ''} aria-label="Preview URL" placeholder="https://localhost:3000" onChange={(event) => patch({ url: event.target.value })} /></div>
          {safeWebUrl(data.url ?? '')
            ? <iframe title={`${data.title} web preview`} src={safeWebUrl(data.url ?? '')} sandbox="allow-scripts" loading="lazy" />
            : <div className="preview-empty"><span>↗</span><p>Enter a local or web URL to preview it here.</p><small>Only HTTP and HTTPS pages are loaded.</small></div>}
        </div>
      )}

      <Handle type="source" position={Position.Right} className="flow-handle" />
    </article>
  )
}
