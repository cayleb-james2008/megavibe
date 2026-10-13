import { useEffect, useMemo, useRef, useState } from 'react'
import { inDesktopApp, invoke } from './bridge'
import type { BoardItem, BoardItemData, VaultDocument, Workspace } from './model'
import { CodePreview } from './studios/CodePreview'
import { buildRepositoryFigure, generateProjectBrief, type ProjectFile, type RepoFigure } from './studios/project'
import { VaultWorkspace } from './studios/VaultWorkspace'
import './studios/StudiosPage.css'

type StudioTab = 'documents' | 'diagrams' | 'code' | 'vault'

function xml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function boardSvg(nodes: BoardItem[], edges: Workspace['edges']) {
  const scale = 0.65
  const left = Math.min(0, ...nodes.map((node) => node.position.x))
  const top = Math.min(0, ...nodes.map((node) => node.position.y))
  const width = Math.max(720, ...nodes.map((node) => (node.position.x - left) * scale + 360))
  const height = Math.max(450, ...nodes.map((node) => (node.position.y - top) * scale + 150))
  const positions = new Map(nodes.map((node) => [node.id, { x: (node.position.x - left) * scale + 160, y: (node.position.y - top) * scale + 90 }]))
  const lines = edges.map((edge) => {
    const start = positions.get(edge.source)
    const end = positions.get(edge.target)
    return start && end ? `<path d="M ${start.x + 210} ${start.y + 48} C ${start.x + 270} ${start.y + 48}, ${end.x - 60} ${end.y + 48}, ${end.x} ${end.y + 48}" fill="none" stroke="#a77b64" stroke-width="2" marker-end="url(#arrow)"/>` : ''
  }).join('')
  const cards = nodes.map((node) => {
    const point = positions.get(node.id)!
    const title = xml(node.data.title)
    const kind = xml(node.data.kind.toUpperCase())
    return `<g><rect x="${point.x}" y="${point.y}" width="210" height="96" rx="10" fill="#202124" stroke="#675143" stroke-width="2"/><rect x="${point.x}" y="${point.y}" width="210" height="27" rx="10" fill="#2a2421"/><text x="${point.x + 12}" y="${point.y + 18}" font-size="9" letter-spacing="1.2" fill="#e19a75">${kind}</text><text x="${point.x + 12}" y="${point.y + 52}" font-size="16" fill="#ecebea">${title}</text></g>`
  }).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#a77b64"/></marker></defs><rect width="100%" height="100%" fill="#111214"/>${lines}${cards}</svg>`
}

function download(filename: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob([content], { type }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function downloadPng(svg: string, filename: string) {
  const source = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  const image = new Image()
  image.onload = () => {
    const canvas = document.createElement('canvas')
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    canvas.getContext('2d')?.drawImage(image, 0, 0)
    URL.revokeObjectURL(source)
    canvas.toBlob((blob) => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const anchor = document.createElement('a')
      anchor.href = url
      anchor.download = filename
      anchor.click()
      window.setTimeout(() => URL.revokeObjectURL(url), 1000)
    }, 'image/png')
  }
  image.onerror = () => URL.revokeObjectURL(source)
  image.src = source
}

function excalidrawScene(nodes: BoardItem[], edges: Workspace['edges']) {
  const common = (id: string, x: number, y: number, width: number, height: number, type: string) => ({
    id, type, x, y, width, height, angle: 0, strokeColor: '#e5a17d', backgroundColor: '#202124', fillStyle: 'solid', strokeWidth: 2, strokeStyle: 'solid', roughness: 0, opacity: 100, groupIds: [], frameId: null, roundness: { type: 3 }, seed: Math.abs(id.split('').reduce((sum, char) => sum + char.charCodeAt(0), 0)) + 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: Date.now(), link: null, locked: false,
  })
  const shapes = nodes.flatMap((node) => {
    const x = node.position.x
    const y = node.position.y
    const shapeId = `shape_${node.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
    const textId = `text_${node.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`
    return [common(shapeId, x, y, 340, 108, 'rectangle'), { ...common(textId, x + 16, y + 20, 310, 32, 'text'), text: node.data.title, originalText: node.data.title, fontSize: 18, fontFamily: 1, textAlign: 'left', verticalAlign: 'top', baseline: 17, containerId: shapeId, autoResize: true, lineHeight: 1.25 }]
  })
  const nodeById = new Map(nodes.map((node) => [node.id, node]))
  const arrows = edges.flatMap((edge, index) => {
    const from = nodeById.get(edge.source)
    const to = nodeById.get(edge.target)
    if (!from || !to) return []
    const dx = to.position.x - from.position.x
    const dy = to.position.y - from.position.y
    return [{ ...common(`arrow_${index}`, from.position.x + 340, from.position.y + 52, dx - 340, dy, 'arrow'), points: [[0, 0], [dx - 340, dy]], lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: 'arrow' }]
  })
  return { type: 'excalidraw', version: 2, source: 'megavibe', elements: [...shapes, ...arrows], appState: { viewBackgroundColor: '#111214', gridSize: null }, files: {} }
}

export function StudiosPage({ workspace, onAdd, onUpdate, onOpenBoard, onVaultChange, onRegisterVaultFlush, onPinCode, onPinDiagram }: {
  workspace: Workspace
  onAdd: () => void
  onUpdate: (id: string, update: (data: BoardItemData) => BoardItemData) => void
  onOpenBoard: () => void
  onVaultChange: (documents: VaultDocument[]) => void
  onRegisterVaultFlush: (flush: () => Promise<boolean>) => void
  onPinCode: (path: string, content: string) => void
  onPinDiagram: (svg: string) => void
}) {
  const [tab, setTab] = useState<StudioTab>('documents')
  const [tree, setTree] = useState<ProjectFile[]>([])
  const [treeLoading, setTreeLoading] = useState(true)
  const [selectedPath, setSelectedPath] = useState('')
  const [code, setCode] = useState('')
  const [codeLoading, setCodeLoading] = useState(false)
  const [codeError, setCodeError] = useState('')
  const [treeError, setTreeError] = useState('')
  const [briefStatus, setBriefStatus] = useState('')
  const [briefError, setBriefError] = useState('')
  const [briefRunning, setBriefRunning] = useState(false)
  const [repoFigure, setRepoFigure] = useState<RepoFigure | null>(null)
  const [diagramStatus, setDiagramStatus] = useState('')
  const [diagramError, setDiagramError] = useState('')
  const [diagramRunning, setDiagramRunning] = useState(false)
  const codeRequestRef = useRef(0)
  const boardDiagram = useMemo(() => boardSvg(workspace.nodes, workspace.edges), [workspace.nodes, workspace.edges])
  const notes = workspace.nodes.filter((node) => ['note', 'text', 'checklist'].includes(node.data.kind))

  useEffect(() => {
    let cancelled = false
    codeRequestRef.current += 1
    setTree([])
    setSelectedPath('')
    setCode('')
    setCodeLoading(false)
    setCodeError('')
    setTreeError('')
    setRepoFigure(null)
    if (!workspace.path || !inDesktopApp) { setTreeLoading(false); return }
    setTreeLoading(true)
    void invoke<ProjectFile[]>('list_project_files', { path: workspace.path }).then((result) => { if (!cancelled) { setTree(result); setTreeError('') } }).catch((error) => { if (!cancelled) setTreeError(String(error)) }).finally(() => { if (!cancelled) setTreeLoading(false) })
    return () => { cancelled = true; codeRequestRef.current += 1 }
  }, [workspace.id, workspace.path])

  async function openCode(path: string) {
    if (!workspace.path) return
    const request = ++codeRequestRef.current
    setSelectedPath(path)
    setCode('')
    setCodeError('')
    setCodeLoading(true)
    try {
      const content = await invoke<string>('read_project_file', { path: workspace.path, relativePath: path })
      if (request === codeRequestRef.current) { setCode(content); setCodeLoading(false) }
    } catch (error) {
      if (request === codeRequestRef.current) { setCodeError(String(error)); setCodeLoading(false) }
    }
  }

  function createVaultDocument(content = `# ${workspace.name}\n\n## Overview\n\nAdd a short project brief here.\n`) {
    const next = [...(workspace.vault ?? []), { id: crypto.randomUUID(), title: 'Untitled note', content }]
    onVaultChange(next)
    setTab('vault')
  }

  async function makeProjectBrief() {
    setBriefRunning(true)
    setBriefError('')
    setBriefStatus('Inspecting the local workspace…')
    try {
      const content = await generateProjectBrief(workspace, setBriefStatus)
      const title = `${workspace.name} — Project brief`
      const next = [...(workspace.vault ?? []), { id: crypto.randomUUID(), title, content }]
      onVaultChange(next)
      setBriefStatus('Project brief created in your local Markdown vault.')
      setTab('vault')
    } catch (error) {
      setBriefStatus('')
      setBriefError(`Could not generate the local project brief. ${String(error)}`)
    } finally {
      setBriefRunning(false)
    }
  }

  async function makeRepositoryDiagram() {
    setDiagramRunning(true)
    setDiagramError('')
    setDiagramStatus('Reading project files locally…')
    try {
      const figure = await buildRepositoryFigure(workspace, setDiagramStatus)
      setRepoFigure(figure)
      setDiagramStatus(`Mapped ${figure.files} source files into ${figure.modules} modules and ${figure.relationships} import relationships.`)
    } catch (error) {
      setDiagramStatus('')
      setDiagramError(String(error))
    } finally {
      setDiagramRunning(false)
    }
  }

  const safeName = workspace.name.replace(/[^a-z0-9-_]+/gi, '-')

  return <div className="secondary-page studios-page">
    <div className="page-intro"><div><span className="eyebrow">PROJECT ARTIFACTS</span><h1>Studios</h1><p>Generate project documents, map repository structure, inspect code, and maintain a local Markdown vault.</p></div><button className="button button-primary" onClick={onAdd}>＋ New note</button></div>
    <nav className="studio-tabs" aria-label="Project studios">{(['documents', 'diagrams', 'code', 'vault'] as const).map((item) => <button key={item} className={tab === item ? 'active' : ''} onClick={() => setTab(item)}>{item === 'documents' ? 'Documents' : item === 'diagrams' ? 'Diagrams' : item === 'code' ? 'Code' : 'Markdown vault'}</button>)}</nav>

    {tab === 'documents' && <>
      <div className="studio-actions"><div><h2>Project documents</h2><p>Generate a repo-aware project brief locally, edit it in the Markdown vault, and export it as a paginated PDF.</p></div><div><button className="button button-outline" onClick={() => void makeProjectBrief()} disabled={briefRunning}>{briefRunning ? 'Generating…' : 'Generate project brief'}</button><button className="button button-outline" onClick={() => createVaultDocument()}>＋ New document</button></div></div>
      {(briefStatus || briefError) && <div className={`studio-generation-status ${briefError ? 'error' : ''}`} role="status">{briefError || briefStatus}</div>}
      {notes.length ? <div className="studio-grid">{notes.map((node) => <article className={`studio-card studio-${node.data.kind}`} key={node.id}><div className="studio-card-head"><span>{node.data.kind === 'checklist' ? '☑ Checklist' : '✎ Board note'}</span><button className="text-button" onClick={onOpenBoard}>Open board ↗</button></div><input className="studio-title" value={node.data.title} onChange={(event) => onUpdate(node.id, (data) => ({ ...data, title: event.target.value }))} />{node.data.kind === 'checklist' ? <div className="studio-checklist">{(node.data.items ?? []).map((item) => <div key={item.id}><span className={item.done ? 'done' : ''}>{item.done ? '✓' : '○'}</span>{item.text}</div>)}<small>{(node.data.items ?? []).filter((item) => item.done).length} of {(node.data.items ?? []).length} complete</small></div> : <textarea value={node.data.content ?? ''} onChange={(event) => onUpdate(node.id, (data) => ({ ...data, content: event.target.value }))} placeholder="Capture a decision, prompt, or project note…" />}<footer><span>⌖ On board</span><span>Saved locally</span></footer></article>)}</div> : <div className="empty-surface"><div className="empty-icon">▤</div><h2>No board notes yet</h2><p>Create a note on the board or start a project brief in the local vault.</p><button className="button button-primary" onClick={() => void makeProjectBrief()}>Generate project brief</button></div>}
    </>}

    {tab === 'diagrams' && <div className="studio-diagram-stack">
      <section className="studio-tool-panel"><div className="studio-actions"><div><h2>Repository architecture</h2><p>Local dependency map grouped by repository module. Relative source imports are read from this project only.</p></div><div><button className="button button-outline" onClick={() => void makeRepositoryDiagram()} disabled={!workspace.path || diagramRunning}>{diagramRunning ? 'Mapping…' : repoFigure ? 'Refresh diagram' : 'Generate diagram'}</button>{repoFigure && <><button className="button button-outline" onClick={() => download(`${safeName}-repository-map.svg`, repoFigure.svg, 'image/svg+xml')}>Export SVG</button><button className="button button-outline" onClick={() => downloadPng(repoFigure.svg, `${safeName}-repository-map.png`)}>Export PNG</button><button className="button button-primary" onClick={() => onPinDiagram(repoFigure.svg)}>Pin to board</button></>}</div></div>
        {!workspace.path && <div className="empty-surface"><h2>No repository is open</h2><p>Open a local project folder to map its source relationships.</p></div>}
        {(diagramStatus || diagramError) && <div className={`studio-generation-status ${diagramError ? 'error' : ''}`} role="status">{diagramError || diagramStatus}</div>}
        {repoFigure && <div className="board-map-preview studio-repository-preview" dangerouslySetInnerHTML={{ __html: repoFigure.svg }} />}
      </section>
      <section className="studio-tool-panel"><div className="studio-actions"><div><h2>Board map</h2><p>A diagram of cards and connections in this workspace.</p></div><div><button className="button button-outline" onClick={() => download(`${safeName}-board-map.svg`, boardDiagram, 'image/svg+xml')}>Export SVG</button><button className="button button-outline" onClick={() => downloadPng(boardDiagram, `${safeName}-board-map.png`)}>Export PNG</button><button className="button button-outline" onClick={() => download(`${safeName}.excalidraw`, JSON.stringify(excalidrawScene(workspace.nodes, workspace.edges), null, 2), 'application/json')}>Export Excalidraw</button><button className="button button-primary" onClick={() => onPinDiagram(boardDiagram)}>Pin to board</button></div></div><div className="board-map-preview" dangerouslySetInnerHTML={{ __html: boardDiagram }} />{!workspace.nodes.length && <p className="studio-empty-hint">Add cards to the board to generate a project map.</p>}</section>
    </div>}

    {tab === 'code' && <section className="studio-tool-panel code-browser"><div className="studio-actions"><div><h2>Repository files</h2><p>{workspace.path ?? 'Open a project folder to browse source files.'} · read-only preview · files over 1 MB are skipped</p></div></div>{!workspace.path ? <div className="empty-surface"><h2>No project is open</h2><p>Choose a local repository to browse files.</p></div> : <div className="code-workspace"><nav className="code-tree" aria-label="Project files">{tree.map((entry) => <button className={selectedPath === entry.path ? 'selected' : ''} key={entry.path} style={{ paddingLeft: `${12 + entry.path.split('/').length * 10}px` }} disabled={entry.directory} onClick={() => void openCode(entry.path)}><span>{entry.directory ? '▸' : '·'}</span>{entry.path.split('/').pop()}</button>)}{treeLoading && <p className="code-loading">Loading files…</p>}{!treeLoading && !treeError && !tree.length && <p className="code-loading">{inDesktopApp ? 'No files found in this project.' : 'File browsing is available in the desktop app.'}</p>}{treeError && <p className="code-error">{treeError}</p>}</nav><article className="code-preview">{selectedPath ? <><header><code>{selectedPath}</code><button className="button button-outline" onClick={() => onPinCode(selectedPath, code)} disabled={!code}>Pin to board</button></header>{codeError ? <p className="code-error">{codeError}</p> : codeLoading ? <div className="code-placeholder"><p>Loading local source…</p></div> : <CodePreview path={selectedPath} content={code} />}</> : <div className="code-placeholder"><span>‹/›</span><p>Select a source file to preview it.</p></div>}</article></div>}</section>}

    <div className={`studio-vault-layer ${tab === 'vault' ? '' : 'studio-vault-layer-hidden'}`} aria-hidden={tab !== 'vault'}>
      <VaultWorkspace key={workspace.id} workspace={workspace} onVaultChange={onVaultChange} onRegisterFlush={onRegisterVaultFlush} />
    </div>
  </div>
}
