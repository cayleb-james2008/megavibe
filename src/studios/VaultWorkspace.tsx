import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { inDesktopApp, invoke } from '../bridge'
import { Icon } from '../Icons'
import type { VaultDocument, Workspace } from '../model'
import { downloadMarkdownPdf } from './pdfExport'
import { layoutVaultGraph, linkVaultEntries, migrateLegacyVault, parseVaultFile, serializeVaultEntry, vaultPathForTitle, type VaultEntry, type VaultListing } from './vault'

function legacyEntries(documents: VaultDocument[]): VaultEntry[] {
  const paths = new Set<string>()
  return documents.map((document) => {
    const relativePath = vaultPathForTitle(document.title, document.id, paths)
    paths.add(relativePath.toLowerCase())
    return { ...document, relativePath }
  })
}

function filePathValid(path: string) {
  return path.length > 0 && path.length <= 240 && path.toLowerCase().endsWith('.md') && !path.startsWith('/') && !path.split('/').some((part) => !part || part === '.' || part === '..')
}

export function VaultWorkspace({ workspace, onVaultChange, onRegisterFlush }: { workspace: Workspace; onVaultChange: (documents: VaultDocument[]) => void; onRegisterFlush: (flush: () => Promise<boolean>) => void }) {
  const [entries, setEntries] = useState<VaultEntry[]>([])
  const [selectedId, setSelectedId] = useState('')
  const [ready, setReady] = useState(false)
  const [filesystemAvailable, setFilesystemAvailable] = useState(false)
  const [listingTruncated, setListingTruncated] = useState(false)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [renaming, setRenaming] = useState(false)
  const [pathDraft, setPathDraft] = useState('')
  const dirtyPaths = useRef(new Map<string, number>())
  const entriesRef = useRef(entries)
  const flushQueueRef = useRef<Promise<boolean> | null>(null)
  const mountedRef = useRef(true)
  const generation = useRef(0)
  const onVaultChangeRef = useRef(onVaultChange)
  const workspaceVaultRef = useRef(workspace.vault ?? [])
  entriesRef.current = entries
  onVaultChangeRef.current = onVaultChange
  workspaceVaultRef.current = workspace.vault ?? []
  const active = entries.find((entry) => entry.id === selectedId) ?? entries[0]
  const links = useMemo(() => linkVaultEntries(entries), [entries])
  const points = useMemo(() => layoutVaultGraph(entries, links), [entries, links])

  const reloadVault = useCallback(async (cancelled?: () => boolean) => {
    const request = ++generation.current
    dirtyPaths.current.clear()
    setFilesystemAvailable(false)
    setListingTruncated(false)
    setReady(false)
    setError('')
    if (!inDesktopApp) {
      const browserEntries = legacyEntries(workspaceVaultRef.current)
      setEntries(browserEntries)
      setSelectedId((current) => browserEntries.some((entry) => entry.id === current) ? current : browserEntries[0]?.id ?? '')
      setReady(true)
      return
    }
    try {
      const listing = await invoke<VaultListing>('list_vault_files', { workspaceId: workspace.id, projectPath: workspace.path })
      if (request !== generation.current || cancelled?.()) return
      setFilesystemAvailable(true)
      setListingTruncated(listing.truncated)
      const migration = migrateLegacyVault(workspaceVaultRef.current, listing.files)
      setEntries(migration.entries)
      setSelectedId((current) => migration.entries.some((entry) => entry.id === current) ? current : migration.entries[0]?.id ?? '')
      if (migration.imports.length && !listing.truncated) {
        setSaving(true)
        try {
          for (const entry of migration.imports) {
            await invoke<void>('write_vault_file', { workspaceId: workspace.id, projectPath: workspace.path, relativePath: entry.relativePath, content: serializeVaultEntry(entry) })
          }
          const migratedFiles = await invoke<VaultListing>('list_vault_files', { workspaceId: workspace.id, projectPath: workspace.path })
          if (request !== generation.current || cancelled?.()) return
          setListingTruncated(migratedFiles.truncated)
          const migratedEntries = migratedFiles.files.map(parseVaultFile)
          setEntries(migratedEntries)
          setSelectedId((current) => migratedEntries.some((entry) => entry.id === current) ? current : migratedEntries[0]?.id ?? '')
          // Clear the compatibility cache only after every import and the verification listing succeeded.
          onVaultChangeRef.current([])
        } catch (cause) {
          if (request === generation.current && !cancelled?.()) setError(`Some older notes could not be imported. They are still available here; retry after fixing the local vault error. ${String(cause)}`)
        } finally {
          if (request === generation.current) setSaving(false)
        }
      }
    } catch (cause) {
      if (request !== generation.current || cancelled?.()) return
      setFilesystemAvailable(false)
      setListingTruncated(false)
      const fallback = legacyEntries(workspaceVaultRef.current)
      setEntries(fallback)
      setError(`Could not read the local Markdown vault. Legacy notes remain available, but file changes will use the compatibility store until the local folder is accessible. ${String(cause)}`)
    } finally {
      if (request === generation.current && !cancelled?.()) setReady(true)
    }
  }, [workspace.id, workspace.path])

  useEffect(() => {
    let cancelled = false
    void reloadVault(() => cancelled)
    return () => { cancelled = true; generation.current += 1 }
  }, [reloadVault])

  useEffect(() => {
    setPathDraft(active?.relativePath ?? '')
  }, [active?.id, active?.relativePath])

  const flushFiles = useCallback(() => {
    const run = async (): Promise<boolean> => {
      if (!inDesktopApp || !dirtyPaths.current.size) return true
      if (mountedRef.current) setSaving(true)
      const pending = [...dirtyPaths.current.entries()]
      try {
        for (const [path, version] of pending) {
          const entry = entriesRef.current.find((item) => item.relativePath === path)
          if (!entry) continue
          await invoke<void>('write_vault_file', { workspaceId: workspace.id, projectPath: workspace.path, relativePath: path, content: serializeVaultEntry(entry) })
          if (dirtyPaths.current.get(path) === version) dirtyPaths.current.delete(path)
        }
        if (mountedRef.current) setError(dirtyPaths.current.size ? 'New edits are waiting to be saved.' : '')
        return dirtyPaths.current.size === 0
      } catch (cause) {
        if (mountedRef.current) setError(`Could not save the Markdown file. Your editor contents are still here. Use Retry save when the local vault is writable. ${String(cause)}`)
        return false
      } finally {
        if (mountedRef.current) setSaving(false)
      }
    }
    const previous = flushQueueRef.current
    const task = previous ? previous.catch(() => undefined).then(run) : run()
    flushQueueRef.current = task
    void task.then(() => {
      if (flushQueueRef.current === task) flushQueueRef.current = null
    }, () => {
      if (flushQueueRef.current === task) flushQueueRef.current = null
    })
    return task
  }, [workspace.id, workspace.path])

  const flushFilesRef = useRef(flushFiles)
  flushFilesRef.current = flushFiles

  useEffect(() => {
    onRegisterFlush(flushFiles)
    return () => onRegisterFlush(() => Promise.resolve(dirtyPaths.current.size === 0))
  }, [flushFiles, onRegisterFlush])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      void flushFilesRef.current()
    }
  }, [])

  useEffect(() => {
    if (!inDesktopApp || !ready || dirtyPaths.current.size === 0) return
    const timer = window.setTimeout(() => { void flushFiles() }, 350)
    return () => window.clearTimeout(timer)
  }, [entries, ready, flushFiles])

  function setChanged(next: VaultEntry[]) {
    setEntries(next)
    entriesRef.current = next
    if (inDesktopApp && filesystemAvailable) {
      const entry = next.find((item) => item.id === active?.id)
      if (entry) dirtyPaths.current.set(entry.relativePath, (dirtyPaths.current.get(entry.relativePath) ?? 0) + 1)
    } else {
      onVaultChange(next.map(({ id, title, content }) => ({ id, title, content })))
    }
  }

  function editActive(update: (entry: VaultEntry) => VaultEntry) {
    if (!active) return
    const next = entries.map((entry) => entry.id === active.id ? update(entry) : entry)
    setChanged(next)
  }

  function createNote() {
    const id = crypto.randomUUID()
    const title = 'Untitled note'
    const path = vaultPathForTitle(title, id, new Set(entries.map((entry) => entry.relativePath.toLowerCase())))
    const entry: VaultEntry = { id, title, relativePath: path, content: `# ${title}\n\n` }
    const next = [...entriesRef.current, entry]
    entriesRef.current = next
    setEntries(next)
    if (inDesktopApp && filesystemAvailable) dirtyPaths.current.set(path, (dirtyPaths.current.get(path) ?? 0) + 1)
    else onVaultChange(next.map(({ id: docId, title: docTitle, content }) => ({ id: docId, title: docTitle, content })))
    setSelectedId(id)
  }

  async function refreshVault() {
    if (inDesktopApp) {
      await flushFiles()
      if (dirtyPaths.current.size) return
    }
    await reloadVault()
  }

  async function deleteNote(entry: VaultEntry) {
    if (!window.confirm(`Delete “${entry.title}” from this local Markdown vault?`)) return
    try {
      if (inDesktopApp && filesystemAvailable) await invoke<void>('delete_vault_file', { workspaceId: workspace.id, projectPath: workspace.path, relativePath: entry.relativePath })
      const next = entries.filter((item) => item.id !== entry.id)
      setEntries(next)
      entriesRef.current = next
      dirtyPaths.current.delete(entry.relativePath)
      if (!inDesktopApp || !filesystemAvailable) onVaultChange(next.map(({ id, title, content }) => ({ id, title, content })))
      setSelectedId(next[0]?.id ?? '')
      setError('')
    } catch (cause) { setError(`Could not delete the Markdown file. ${String(cause)}`) }
  }

  async function renamePath() {
    if (!active || renaming || pathDraft === active.relativePath) return
    if (!filePathValid(pathDraft)) { setError('File path must be a relative .md path without empty, dot, or parent folders.'); return }
    if (entries.some((entry) => entry.id !== active.id && entry.relativePath.toLowerCase() === pathDraft.toLowerCase())) { setError('A file with that path already exists in this vault.'); return }
    setRenaming(true)
    try {
      if (inDesktopApp && filesystemAvailable) {
        if (!(await flushFiles())) {
          setError('Save this note before renaming it. Retry the save when the local vault is writable.')
          return
        }
        await invoke<void>('rename_vault_file', { workspaceId: workspace.id, projectPath: workspace.path, oldRelativePath: active.relativePath, newRelativePath: pathDraft })
      }
      const previousPath = active.relativePath
      const renamed = { ...active, relativePath: pathDraft }
      const next = entries.map((entry) => entry.id === active.id ? renamed : entry)
      setEntries(next)
      entriesRef.current = next
      dirtyPaths.current.delete(previousPath)
      if (!inDesktopApp || !filesystemAvailable) onVaultChange(next.map(({ id, title, content }) => ({ id, title, content })))
      setError('')
    } catch (cause) { setError(`Could not rename this file. The original is kept. ${String(cause)}`) }
    finally { setRenaming(false) }
  }

  function renderGraph() {
    const width = 820
    const height = 430
    return <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Markdown vault graph with ${entries.length} notes and ${links.length} links`}>
      {links.map((link, index) => {
        const from = points.get(link.from)
        const to = points.get(link.to)
        return from && to ? <line key={`${link.from}-${link.to}-${index}`} x1={from.x} y1={from.y} x2={to.x} y2={to.y} stroke="#805c49" strokeWidth="1.5" /> : null
      })}
      {entries.map((entry) => {
        const point = points.get(entry.id)
        if (!point) return null
        return <g key={entry.id} className={`vault-graph-node ${entry.id === active?.id ? 'selected' : ''}`} role="button" tabIndex={0} aria-label={`Open ${entry.title}`} onClick={() => setSelectedId(entry.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); setSelectedId(entry.id) } }}>
          <circle cx={point.x} cy={point.y} r={entry.id === active?.id ? 11 : 8} />
          <text x={point.x} y={point.y + 23} textAnchor="middle">{entry.title.length > 22 ? `${entry.title.slice(0, 20)}…` : entry.title}</text>
        </g>
      })}
    </svg>
  }

  return <section className="vault-workspace studio-vault-workspace">
    <aside className="vault-sidebar"><div className="vault-sidebar-title"><span>LOCAL MARKDOWN</span><div><button className="icon-button" disabled={renaming} onClick={() => void refreshVault()} aria-label="Refresh Markdown vault" title="Refresh from local files"><Icon name="refresh" size={13} /></button><button className="icon-button" disabled={renaming} onClick={createNote} aria-label="New Markdown note"><Icon name="plus" size={13} /></button></div></div>
      {entries.map((entry) => <button key={entry.id} disabled={renaming} className={entry.id === active?.id ? 'selected' : ''} onClick={() => setSelectedId(entry.id)} title={entry.relativePath}><span><Icon name="note" size={18} /></span><span className="vault-file-name">{entry.title}</span><small>{entry.relativePath.includes('/') ? entry.relativePath.split('/').slice(0, -1).join('/') : ''}</small></button>)}
      {entries.length === 0 && <small>No Markdown files yet. Create a note to add one to the local vault.</small>}
    </aside>
    <div className="vault-editor-area">
      {error && <div className="studio-local-error" role="status">{error}</div>}
      {listingTruncated && <div className="studio-local-warning" role="status">The vault listing is capped at 1,000 files, 16 folder levels, and 16 MiB of Markdown. Some notes are omitted; move or reduce files, then refresh to load more.</div>}
      {active ? <>
        <div className="vault-editor-header"><input disabled={renaming} value={active.title} aria-label="Markdown note title" onChange={(event) => editActive((entry) => ({ ...entry, title: event.target.value }))} /><button className="button button-outline" onClick={() => downloadMarkdownPdf(active.title, active.content)}>Export PDF</button><button className="button button-outline" onClick={() => { const url = URL.createObjectURL(new Blob([active.content], { type: 'text/markdown;charset=utf-8' })); const anchor = document.createElement('a'); anchor.href = url; anchor.download = active.relativePath.split('/').pop() ?? 'note.md'; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000) }}>Download .md</button></div>
        <div className="vault-file-path"><label htmlFor="vault-file-path">File path</label><input id="vault-file-path" disabled={renaming} value={pathDraft} onChange={(event) => setPathDraft(event.target.value)} /><button className="text-button" onClick={() => void renamePath()} disabled={renaming || pathDraft === active.relativePath}>{renaming ? 'Renaming…' : 'Rename'}</button><button className="text-button vault-delete" onClick={() => void deleteNote(active)} disabled={renaming}>Delete</button></div>
        <textarea disabled={renaming} value={active.content} aria-label="Markdown editor" onChange={(event) => editActive((entry) => ({ ...entry, content: event.target.value }))} spellCheck={false} />
        <footer>{saving ? 'Saving to local Markdown file…' : dirtyPaths.current.size ? 'Unsaved local edits' : inDesktopApp && filesystemAvailable ? 'Saved to local Markdown file' : 'Saved to this browser workspace'} · link notes with [[Note title]] · {active.relativePath}</footer>
        {inDesktopApp && error && dirtyPaths.current.size > 0 && <button className="text-button studio-retry-save" onClick={() => void flushFiles()}>Retry save</button>}
      </> : <div className="code-placeholder"><span><Icon name="note" size={18} /></span><p>Create a Markdown note for this workspace.</p><button className="button button-primary" onClick={createNote}><Icon name="plus" size={13} /> New note</button></div>}
    </div>
    <aside className="vault-graph studio-vault-graph"><div className="studio-graph-head"><h3>LINK GRAPH</h3><span>Force-directed note map</span></div>{entries.length ? renderGraph() : <p>Notes and their links appear here.</p>}<small>{entries.length} notes · {links.length} links</small></aside>
  </section>
}
