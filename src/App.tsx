import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { listen } from '@tauri-apps/api/event'
import {
  addEdge,
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type NodeChange,
  type XYPosition,
} from '@xyflow/react'
import { BoardCard } from './BoardCard'
import { StudiosPage as StudioWorkspacePage } from './StudiosPage'
import { UsagePage as UsageDashboard } from './UsagePage'
import { VoicePage as VoiceWorkspacePage, type VoiceAction } from './VoicePage'
import './App.css'
import { BoardRuntimeProvider, type BoardRuntime, type RuntimeStatus } from './BoardRuntime'
import { chooseFolder, inDesktopApp, invoke, loadState, outputChannel, saveState } from './bridge'
import {
  cliCommands,
  createInitialState,
  createCliSessionId,
  createWorkspace,
  getSessionStartArgs,
  getApprovalArgs,
  getResumeArgs,
  migrateAppState,
  makeId,
  supportsSessionIdentity,
  type AppState,
  type BoardItem,
  type BoardItemData,
  type CliProfile,
  type LoopRule,
  type ItemKind,
  type Team,
  type TeamMember,
  type Workspace,
} from './model'
import '@xyflow/react/dist/style.css'
import '@xterm/xterm/css/xterm.css'

type Page = 'board' | 'voice' | 'teams' | 'studios' | 'git' | 'usage' | 'memory' | 'profiles' | 'loops' | 'settings'
type TerminalDraft = { id?: string; title: string; command: string; argsText: string; resumeArgsText: string; cwd: string; profileId?: string }
type StartupResumeCandidate = { terminalId: string; workspaceId: string; workspaceName: string; title: string; command: string; cwd: string; profileName: string; resume: boolean }

const nodeTypes = { boardItem: BoardCard }
const CLI_PRESETS = [
  { label: 'Shell', command: 'bash' },
  { label: 'Claude Code', command: 'claude' },
  { label: 'Codex', command: 'codex' },
  { label: 'Gemini CLI', command: 'gemini' },
]

function stripTerminalFormatting(value: string) {
  return value
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '')
}

function detectNeedsYou(value: string) {
  return /(?:permission required|waiting for approval|approve (?:this|the)|do you want to proceed|press (?:enter|y) to confirm|needs? (?:your )?input|would you like to allow|allow (?:this|the) command)/i.test(value)
}

function summarizeTerminalOutput(value: string) {
  const redacted = stripTerminalFormatting(value)
    .replace(/\b(?:sk|ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{12,}\b/g, '[redacted token]')
    .replace(/\b(api[_-]?key|token|secret|password)\s*[:=]\s*\S+/gi, '$1=[redacted]')
  const lines = redacted.split(/\r?\n/).map((line) => line.replace(/\s+/g, ' ').trim()).filter((line) => line.length > 8)
  const recent = [...new Set(lines.slice(-120))].slice(-16)
  if (!recent.length) return 'No readable terminal output is available yet. Add the completed work, current state, and next step.'
  return [
    'Local draft generated from recent terminal output. Review and edit before preparing it.',
    '',
    'Recent output:',
    ...recent.map((line) => `- ${line.slice(0, 360)}`),
    '',
    'Next step: [add the remaining task and any relevant files]',
  ].join('\n')
}

function downloadMarkdown(filename: string, content: string) {
  const url = URL.createObjectURL(new Blob([content], { type: 'text/markdown;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  anchor.click()
  window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function useEscapeKey(onEscape: () => void, enabled = true) {
  const handlerRef = useRef(onEscape)
  handlerRef.current = onEscape
  useEffect(() => {
    if (!enabled) return
    const handler = (event: KeyboardEvent) => {
      if (event.key === 'Escape') handlerRef.current()
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [enabled])
}

function App() {
  const [state, setStateUnsafe] = useState<AppState>(() => createInitialState())
  const [loaded, setLoaded] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [loadAttempt, setLoadAttempt] = useState(0)
  const [page, setPage] = useState<Page>('board')
  const [saving, setSaving] = useState<'saved' | 'saving' | 'error'>('saved')
  const [closing, setClosing] = useState(false)
  const [notice, setNotice] = useState('')
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false)
  const [terminalDraft, setTerminalDraft] = useState<TerminalDraft | null>(null)
  const [startupResumes, setStartupResumes] = useState<StartupResumeCandidate[] | null>(null)
  const [selectedResumeIds, setSelectedResumeIds] = useState<string[]>([])
  const [teamDialog, setTeamDialog] = useState(false)
  const [teamMentionTarget, setTeamMentionTarget] = useState<string | null>(null)
  const [batchDialog, setBatchDialog] = useState(false)
  const [loopDialog, setLoopDialog] = useState(false)
  const [handoffSource, setHandoffSource] = useState<string | null>(null)
  const [statuses, setStatuses] = useState<Record<string, RuntimeStatus>>({})
  const [missionStatuses, setMissionStatuses] = useState<Record<string, BoardItemData['missionState']>>({})
  const [messages, setMessages] = useState<Record<string, string>>({})
  const stateRef = useRef(state)
  const loadedRef = useRef(loaded)
  const loadErrorRef = useRef(loadError)
  const statusesRef = useRef(statuses)
  const outputBufferRef = useRef<Record<string, string>>({})
  const lastOutputAtRef = useRef<Record<string, number>>({})
  const outputSequenceRef = useRef<Record<string, number>>({})
  const outputChunksRef = useRef<Record<string, Array<{ sequence: number; text: string }>>>({})
  const loopMarkerScanRef = useRef<Record<string, string>>({})
  const runTokenRef = useRef<Record<string, number>>({})
  const closingRef = useRef(false)
  const startTasksRef = useRef<Record<string, Promise<void>>>({})
  const stopTasksRef = useRef<Record<string, Promise<boolean>>>({})
  const workspaceMenuRef = useRef<HTMLDivElement>(null)
  const vaultFlushRef = useRef<() => Promise<boolean>>(() => Promise.resolve(true))
  const saveQueue = useRef<Promise<void>>(Promise.resolve())
  const autosaveTimer = useRef<number | undefined>(undefined)
  const toastTimer = useRef<number | undefined>(undefined)
  stateRef.current = state
  loadedRef.current = loaded
  loadErrorRef.current = loadError
  statusesRef.current = statuses

  const setState = useCallback((action: Parameters<typeof setStateUnsafe>[0]) => {
    if (!closingRef.current) setStateUnsafe(action)
  }, [])

  const registerVaultFlush = useCallback((flush: () => Promise<boolean>) => {
    vaultFlushRef.current = flush
  }, [])

  useEffect(() => {
    let cancelled = false
    void loadState().then((stored) => {
      if (cancelled || !stored) return
      const loadedState = migrateAppState(stored)
      setState(loadedState)
      const candidates = loadedState.workspaces.flatMap((item) => item.nodes
        .filter((node) => node.data.kind === 'terminal' && node.data.resumeOnLaunch)
        .map((node) => ({
          terminalId: node.id,
          workspaceId: item.id,
          workspaceName: item.name,
          title: node.data.title,
          command: node.data.command ?? 'bash',
          cwd: node.data.cwd || item.path || 'Home directory',
          profileName: node.data.profileId
            ? loadedState.profiles.find((profile) => profile.id === node.data.profileId)?.name ?? node.data.profileId
            : 'Default profile',
          resume: Boolean(getResumeArgs(node.data.command ?? 'bash', node.data.resumeArgs, node.data.sessionId)),
        })))
      if (candidates.length) {
        setStartupResumes(candidates)
        setSelectedResumeIds(candidates.map((candidate) => candidate.terminalId))
      } else {
        setStartupResumes(null)
      }
    }).catch((error) => {
      if (!cancelled) setLoadError(String(error))
    }).finally(() => {
      if (!cancelled) setLoaded(true)
    })
    return () => { cancelled = true }
  }, [loadAttempt])

  useEffect(() => {
    if (!loaded || loadError || closingRef.current) return
    setSaving('saving')
    const timer = window.setTimeout(() => {
      if (autosaveTimer.current === timer) autosaveTimer.current = undefined
      saveQueue.current = saveQueue.current.catch(() => undefined).then(() => saveState(state)).then(() => {
        setSaving('saved')
      }).catch((error) => {
        setSaving('error')
        showNotice(`Could not save workspace: ${String(error)}`)
      })
    }, 450)
    autosaveTimer.current = timer
    return () => {
      window.clearTimeout(timer)
      if (autosaveTimer.current === timer) autosaveTimer.current = undefined
    }
  }, [state, loaded])

  useEffect(() => () => window.clearTimeout(toastTimer.current), [])

  useEffect(() => {
    const timer = window.setInterval(() => {
      const now = Date.now()
      setState((current) => {
        if (closingRef.current) return current
        let changed = false
        const loops = current.loops.map((loop) => {
          if (!loop.enabled || loop.goalMet || loop.pending) return loop
          if (loop.runs >= loop.maxRuns) { changed = true; return { ...loop, enabled: false } }
          if (statusesRef.current[loop.terminalId] !== 'running') return loop
          const sequence = outputSequenceRef.current[loop.terminalId] ?? 0
          const elapsed = now - (loop.lastTriggeredAt ?? loop.createdAt)
          const interval = Math.max(1, loop.intervalMinutes) * 60_000
          const sinceOutput = now - (lastOutputAtRef.current[loop.terminalId] ?? loop.createdAt)
          const outputText = (outputChunksRef.current[loop.terminalId] ?? [])
            .filter((chunk) => chunk.sequence > (loop.lastOutputSequence ?? 0))
            .map((chunk) => chunk.text)
            .join('')
          const due = loop.trigger === 'schedule'
            ? elapsed >= interval
            : loop.trigger === 'idle'
              ? sinceOutput >= interval && elapsed >= interval
              : sequence > (loop.lastOutputSequence ?? 0) && (!loop.outputMatch || outputText.toLowerCase().includes(loop.outputMatch.toLowerCase()))
          if (!due) return loop
          changed = true
          const runs = loop.runs + 1
          return { ...loop, pending: true, runs, lastTriggeredAt: now, lastOutputSequence: sequence, enabled: runs < loop.maxRuns }
        })
        return changed ? { ...current, loops } : current
      })
    }, 3000)
    return () => window.clearInterval(timer)
  }, [])

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (closingRef.current) return
      const now = Date.now()
      setMissionStatuses((current) => {
        let changed = false
        const next = { ...current }
        for (const [id, missionStatus] of Object.entries(current)) {
          if (missionStatus === 'working' && now - (lastOutputAtRef.current[id] ?? now) > 60_000) {
            next[id] = 'resting'
            changed = true
          }
        }
        return changed ? next : current
      })
      setState((current) => {
        let changed = false
        const workspaces = current.workspaces.map((item) => {
          let workspaceChanged = false
          const nodes = item.nodes.map((node) => {
            if (node.data.kind !== 'terminal') return node
            const latest = (outputBufferRef.current[node.id] ?? node.data.scrollback ?? '').slice(-128 * 1024)
            if (latest === (node.data.scrollback ?? '')) return node
            changed = true
            workspaceChanged = true
            return { ...node, data: { ...node.data, scrollback: latest } }
          })
          return workspaceChanged ? { ...item, nodes } : item
        })
        return changed ? { ...current, workspaces } : current
      })
    }, 1500)
    return () => window.clearInterval(timer)
  }, [setState])

  useEffect(() => {
    if (!inDesktopApp) return
    let unlisten: (() => void) | undefined
    let cancelled = false
    void listen('megavibe-close-request', async () => {
      if (closingRef.current) return
      if (!loadedRef.current || loadErrorRef.current) {
        try {
          await invoke('close_application')
        } catch (error) {
          showNotice(`Could not close Megavibe: ${String(error)}`)
        }
        return
      }
      const active = Object.entries(statusesRef.current)
        .filter(([, status]) => status === 'running' || status === 'starting' || status === 'stopping')
        .map(([id]) => id)
      if (active.length && !window.confirm(`Stop ${active.length} active ${active.length === 1 ? 'console' : 'consoles'} and close Megavibe?`)) return
      closingRef.current = true
      setClosing(true)
      if (autosaveTimer.current !== undefined) {
        window.clearTimeout(autosaveTimer.current)
        autosaveTimer.current = undefined
      }
      const pendingStops = Object.entries(stopTasksRef.current).map(([id, promise]) => ({ id, promise }))
      try {
        await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()))
        await Promise.all(Object.values(startTasksRef.current))
        const pendingStopResults = await Promise.all(pendingStops.map(({ promise }) => promise))
        if (pendingStopResults.some((stopped) => !stopped)) throw new Error('A console could not be stopped.')
        if (!(await vaultFlushRef.current())) throw new Error('A Markdown vault note could not be saved.')
        const running = Object.entries(statusesRef.current)
          .filter(([, status]) => status === 'running' || status === 'starting')
          .map(([id]) => id)
        const current = stateRef.current
        const runningIds = new Set(running)
        const stoppedIds = new Set(active.filter((id) => !runningIds.has(id)))
        const preserved = active.length ? {
          ...current,
          workspaces: current.workspaces.map((item) => ({
          ...item,
            nodes: item.nodes.map((node) => {
              const scrollback = node.data.kind === 'terminal'
                ? (outputBufferRef.current[node.id] ?? node.data.scrollback ?? '').slice(-128 * 1024)
                : node.data.scrollback
              const resumeOnLaunch = runningIds.has(node.id) ? true : stoppedIds.has(node.id) ? false : node.data.resumeOnLaunch
              if (scrollback === node.data.scrollback && resumeOnLaunch === node.data.resumeOnLaunch) return node
              return { ...node, data: { ...node.data, scrollback, resumeOnLaunch } }
            }),
          })),
        } : current
        if (preserved !== current) {
          stateRef.current = preserved
          setStateUnsafe(preserved)
        }
        saveQueue.current = saveQueue.current.catch(() => undefined).then(() => saveState(preserved))
        await saveQueue.current
        for (const id of running) {
          const runToken = runTokenRef.current[id]
          if (runToken !== undefined) await invoke('stop_terminal', { id, runToken })
        }
        await invoke('close_application')
      } catch (error) {
        closingRef.current = false
        setClosing(false)
        setSaving('error')
        showNotice(`Megavibe stayed open because it could not save or stop every console: ${String(error)}`)
      }
    }).then((stop) => {
      if (cancelled) stop()
      else unlisten = stop
    }).catch((error) => showNotice(`Could not prepare the close prompt: ${String(error)}`))
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  const workspace = useMemo(
    () => state.workspaces.find((item) => item.id === state.activeWorkspaceId) ?? state.workspaces[0],
    [state],
  )
  const voiceBoardContext = useMemo(() => {
    if (!workspace) return ''
    const board: Array<Record<string, unknown>> = []
    for (const node of workspace.nodes) {
      const data = node.data
      if (data.kind === 'note' || data.kind === 'text') board.push({ kind: data.kind, title: data.title, content: (data.content ?? '').slice(0, 2000) })
      else if (data.kind === 'checklist') board.push({ kind: data.kind, title: data.title, items: (data.items ?? []).slice(0, 30).map(({ text, done }) => ({ text, done })) })
      else if (data.kind === 'kanban') board.push({ kind: data.kind, title: data.title, tasks: (data.tasks ?? []).slice(0, 30).map(({ text, status }) => ({ text, status })) })
    }
    return JSON.stringify({ workspace: workspace.name, board }).slice(0, 12000)
  }, [workspace])

  function showNotice(text: string) {
    setNotice(text)
    window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setNotice(''), 5000)
  }

  useEffect(() => {
    if (!workspaceMenuOpen) return
    const close = (event: MouseEvent) => {
      if (!workspaceMenuRef.current?.contains(event.target as Node)) setWorkspaceMenuOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [workspaceMenuOpen])
  useEscapeKey(() => setWorkspaceMenuOpen(false), workspaceMenuOpen)

  const updateWorkspace = useCallback((id: string, update: (workspace: Workspace) => Workspace) => {
    setState((current) => ({
      ...current,
      workspaces: current.workspaces.map((item) => item.id === id ? update(item) : item),
    }))
  }, [])

  const setStatus = useCallback((id: string, status: RuntimeStatus) => {
    statusesRef.current = { ...statusesRef.current, [id]: status }
    setStatuses(statusesRef.current)
    if (status !== 'error') setMessages((current) => ({ ...current, [id]: '' }))
  }, [])

  const updateNode = useCallback((id: string, update: (data: BoardItemData) => BoardItemData) => {
    const activeId = stateRef.current.activeWorkspaceId
    updateWorkspace(activeId, (current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === id ? { ...node, data: update(node.data) } : node),
    }))
  }, [updateWorkspace])

  const setTerminalResume = useCallback((id: string, resumeOnLaunch: boolean, workspaceId?: string) => {
    const target = stateRef.current.workspaces.find((item) => item.id === workspaceId)
      ?? stateRef.current.workspaces.find((item) => item.nodes.some((node) => node.id === id))
    if (!target) return
    updateWorkspace(target.id, (current) => ({
      ...current,
      nodes: current.nodes.map((node) => node.id === id ? { ...node, data: { ...node.data, resumeOnLaunch } } : node),
    }))
  }, [updateWorkspace])

  const stopProcess = useCallback(async (id: string, ask: boolean) => {
    const pending = stopTasksRef.current[id]
    if (pending) return pending
    if (closingRef.current) return false
    if (ask && !window.confirm('Stop this local terminal process?')) return false
    const runToken = runTokenRef.current[id]
    if (runToken === undefined) return true
    setStatus(id, 'stopping')
    const request = (async () => {
    try {
      await invoke('stop_terminal', { id, runToken })
      if (runTokenRef.current[id] === runToken) {
        setTerminalResume(id, false)
        setStatus(id, 'stopped')
      }
      return true
    } catch (error) {
      if (runTokenRef.current[id] === runToken) {
        setMessages((current) => ({ ...current, [id]: String(error) }))
        setStatus(id, 'running')
      }
      return false
    } finally {
      delete stopTasksRef.current[id]
    }
    })()
    stopTasksRef.current[id] = request
    return request
  }, [setStatus, setTerminalResume])

  const launchTerminal = useCallback(async (id: string, resume = false, workspaceId?: string) => {
    const current = stateRef.current
    const active = current.workspaces.find((item) => item.id === (workspaceId ?? current.activeWorkspaceId))
    const node = active?.nodes.find((item) => item.id === id)
    if (!active || !node) return
    if (!inDesktopApp) {
      setStatus(id, 'error')
      setMessages((messagesNow) => ({ ...messagesNow, [id]: 'Run Megavibe as a Linux desktop app to open a real local PTY.' }))
      return
    }
    if (statusesRef.current[id] === 'running' || statusesRef.current[id] === 'starting' || statusesRef.current[id] === 'stopping' || Object.prototype.hasOwnProperty.call(stopTasksRef.current, id)) return
    outputSequenceRef.current[id] = 0
    outputBufferRef.current[id] = node.data.scrollback ?? ''
    outputChunksRef.current[id] = []
    loopMarkerScanRef.current[id] = ''
    const runToken = (runTokenRef.current[id] ?? 0) + 1
    runTokenRef.current[id] = runToken
    setState((currentState) => ({ ...currentState, loops: currentState.loops.map((loop) => loop.terminalId === id ? { ...loop, lastOutputSequence: 0 } : loop) }))
    const channel = outputChannel()
    channel.onmessage = (event) => {
      if (event.runToken !== runToken) return
      if (event.kind === 'output') {
        const previous = outputBufferRef.current[id] ?? ''
        outputBufferRef.current[id] = `${previous}${event.data}`.slice(-512 * 1024)
        const markerScan = `${loopMarkerScanRef.current[id] ?? ''}${stripTerminalFormatting(event.data)}`.replace(/\r\n?/g, '\n')
        const markerLines = markerScan.split('\n')
        loopMarkerScanRef.current[id] = markerLines.pop()?.slice(-1024) ?? ''
        const completeLines = new Set(markerLines.map((line) => line.trim()))
        const markerCandidates = stateRef.current.loops.filter((loop) =>
          loop.terminalId === id && loop.runs > 0 && !loop.pending && !loop.goalMet && !loop.completionCandidate
          && completeLines.has(`[MEGAVIBE_LOOP_GOAL_COMPLETE:${loop.id}]`),
        )
        if (markerCandidates.length) {
          const candidateIds = new Set(markerCandidates.map((loop) => loop.id))
          setState((currentState) => ({
            ...currentState,
            loops: currentState.loops.map((loop) => candidateIds.has(loop.id)
              ? { ...loop, completionCandidate: true, enabled: false, pending: false }
              : loop),
          }))
        }
        lastOutputAtRef.current[id] = Date.now()
        const sequence = (outputSequenceRef.current[id] ?? 0) + 1
        outputSequenceRef.current[id] = sequence
        const chunks = [...(outputChunksRef.current[id] ?? []), { sequence, text: event.data }]
        let length = 0
        let firstKept = chunks.length
        for (let index = chunks.length - 1; index >= 0; index--) {
          length += chunks[index].text.length
          if (length > 64 * 1024) { firstKept = index + 1; break }
          firstKept = index
        }
        outputChunksRef.current[id] = chunks.slice(firstKept)
        const promptTail = stripTerminalFormatting(outputBufferRef.current[id].slice(-6000))
        setMissionStatuses((currentStatuses) => ({
          ...currentStatuses,
          [id]: detectNeedsYou(promptTail) ? 'needs-you' : 'working',
        }))
        window.dispatchEvent(new CustomEvent('megavibe:terminal-output', { detail: { id, data: event.data } }))
      } else {
        const exitMessage = `\r\n\x1b[90m[process exited: ${event.data}]\x1b[0m\r\n`
        outputBufferRef.current[id] = `${outputBufferRef.current[id] ?? ''}${exitMessage}`.slice(-512 * 1024)
        window.dispatchEvent(new CustomEvent('megavibe:terminal-output', { detail: { id, data: exitMessage } }))
        if (!closingRef.current) setTerminalResume(id, false, active.id)
        setMissionStatuses((currentStatuses) => ({ ...currentStatuses, [id]: 'resting' }))
        setStatus(id, Object.prototype.hasOwnProperty.call(stopTasksRef.current, id) ? 'stopping' : 'stopped')
      }
    }
    setStatus(id, 'starting')
    setMissionStatuses((currentStatuses) => ({ ...currentStatuses, [id]: 'working' }))
    setTerminalResume(id, true, active.id)
    lastOutputAtRef.current[id] = Date.now()
    try {
      let sessionId = node.data.sessionId
      if (!resume && !sessionId && supportsSessionIdentity(node.data.command || 'bash')) {
        const commandName = node.data.command?.split('/').pop()?.toLowerCase()
        if (commandName === 'claude' || commandName === 'gemini') {
          sessionId = createCliSessionId(node.data.command || 'bash')
          updateWorkspace(active.id, (currentWorkspace) => ({
            ...currentWorkspace,
            nodes: currentWorkspace.nodes.map((currentNode) => currentNode.id === id
              ? { ...currentNode, data: { ...currentNode.data, sessionId } }
              : currentNode),
          }))
        }
      }
      let args = [...(node.data.args ?? [])]
      if (resume) {
        const resumeArgs = getResumeArgs(node.data.command || 'bash', node.data.resumeArgs, sessionId)
        if (!resumeArgs) {
          setTerminalResume(id, false, active.id)
          setStatus(id, 'error')
          setMessages((current) => ({ ...current, [id]: 'This CLI has no configured resume command. Edit the console arguments to choose its resume flow.' }))
          return
        }
        args = [...resumeArgs, ...args]
      } else {
        args = [...getSessionStartArgs(node.data.command || 'bash', sessionId), ...args]
      }
      args.push(...getApprovalArgs(node.data.command || 'bash', current.approvalMode, args))
      await invoke('spawn_terminal', {
        id,
        program: node.data.command || 'bash',
        args,
        cwd: node.data.cwd || active.path,
        profileId: node.data.profileId,
        runToken,
        cols: 100,
        rows: 22,
        onOutput: channel,
      })
      setStatus(id, 'running')
      setMessages((currentMessages) => ({ ...currentMessages, [id]: '' }))
    } catch (error) {
      setTerminalResume(id, false, active.id)
      setStatus(id, 'error')
      setMessages((currentMessages) => ({ ...currentMessages, [id]: String(error) }))
    }
  }, [setStatus, setTerminalResume, updateWorkspace])

  const startTerminal = useCallback((id: string, resume = false, workspaceId?: string) => {
    if (closingRef.current) return Promise.resolve()
    const pending = startTasksRef.current[id]
    if (pending) return pending
    const task = launchTerminal(id, resume, workspaceId)
    startTasksRef.current[id] = task
    const cleanup = () => {
      if (startTasksRef.current[id] === task) delete startTasksRef.current[id]
    }
    void task.then(cleanup, cleanup)
    return task
  }, [launchTerminal])

  const sendText = useCallback(async (id: string, text: string): Promise<boolean> => {
    if (!text.trim()) return false
    if (statusesRef.current[id] !== 'running') {
      showNotice('Start the destination console before preparing text.')
      return false
    }
    try {
      await invoke('paste_terminal', { id, data: text })
      showNotice('Prepared text in the terminal. Review it there and press Enter when you are ready to send it.')
      return true
    } catch (error) {
      showNotice(`Could not prepare terminal text: ${String(error)}`)
      return false
    }
  }, [])

  const prepareHandoff = useCallback((id: string) => setHandoffSource(id), [])
  const getOutput = useCallback((id: string) => outputBufferRef.current[id] ?? '', [])

  const stopTerminal = useCallback((id: string) => {
    void stopProcess(id, true)
  }, [stopProcess])

  const removeNode = useCallback(async (id: string) => {
    if (closingRef.current || statusesRef.current[id] === 'starting' || statusesRef.current[id] === 'stopping') {
      if (!closingRef.current) setMessages((current) => ({ ...current, [id]: 'Wait for this console to finish starting or stopping before removing it.' }))
      return
    }
    if (statusesRef.current[id] === 'running' && !(await stopProcess(id, true))) return
    const activeId = stateRef.current.activeWorkspaceId
    updateWorkspace(activeId, (current) => ({
      ...current,
      nodes: current.nodes.filter((node) => node.id !== id),
      edges: current.edges.filter((edge) => edge.source !== id && edge.target !== id),
    }))
    delete outputBufferRef.current[id]
    delete outputChunksRef.current[id]
    setStatuses((current) => { const next = { ...current }; delete next[id]; return next })
  }, [statuses, stopProcess, updateWorkspace])

  const editTerminal = useCallback((id: string) => {
    const current = stateRef.current
    const active = current.workspaces.find((item) => item.id === current.activeWorkspaceId)
    const node = active?.nodes.find((item) => item.id === id)
    if (node?.data.kind !== 'terminal') return
    setTerminalDraft({
      id,
      title: node.data.title,
      command: node.data.command ?? 'bash',
      argsText: (node.data.args ?? []).join('\n'),
      resumeArgsText: (node.data.resumeArgs ?? []).join('\n'),
      cwd: node.data.cwd ?? active?.path ?? '',
      profileId: node.data.profileId,
    })
  }, [])

  const addTerminal = useCallback((command: string, title: string, team?: string) => {
    const activeId = stateRef.current.activeWorkspaceId
    updateWorkspace(activeId, (current) => ({
      ...current,
      nodes: [...current.nodes, {
        id: makeId('terminal'),
        type: 'boardItem',
        position: { x: 330 + (current.nodes.length % 4) * 78, y: 270 + current.nodes.length * 35 },
        style: { width: 500 },
        data: { kind: 'terminal', title, command, args: [], team, sessionId: createCliSessionId(command) },
      }],
    }))
    setPage('board')
  }, [updateWorkspace])

  async function addBatch(items: Array<{ title: string; command: string }>) {
    const activeId = stateRef.current.activeWorkspaceId
    const currentState = stateRef.current
    const active = currentState.workspaces.find((item) => item.id === activeId)
    if (!active) return
    const created = items.map((item, index) => ({
        id: makeId('terminal'),
        type: 'boardItem' as const,
        position: { x: 300 + (index % 4) * 540, y: 220 + Math.floor(index / 4) * 300 },
        style: { width: 500 },
        data: { kind: 'terminal' as const, title: item.title, command: item.command, args: [], sessionId: createCliSessionId(item.command) },
      }))
    const nextState = {
      ...currentState,
      workspaces: currentState.workspaces.map((item) => item.id === activeId
        ? { ...item, nodes: [...item.nodes, ...created] }
        : item),
    }
    stateRef.current = nextState
    setState(nextState)
    setBatchDialog(false)
    setPage('board')
    showNotice(`Launching ${items.length} console${items.length === 1 ? '' : 's'}…`)
    await Promise.all(created.map((node) => startTerminal(node.id, false, activeId)))
  }

  async function startAllTerminals() {
    const active = stateRef.current.workspaces.find((item) => item.id === stateRef.current.activeWorkspaceId)
    if (!active) return
    for (const node of active.nodes.filter((item) => item.data.kind === 'terminal')) {
      if (statusesRef.current[node.id] !== 'running' && statusesRef.current[node.id] !== 'starting') await startTerminal(node.id)
    }
  }

  async function startSavedTerminals(ids: string[]) {
    if (!startupResumes) return
    const selected = startupResumes.filter((candidate) => ids.includes(candidate.terminalId))
    if (selected.length && selected[0].workspaceId !== stateRef.current.activeWorkspaceId && !(await vaultFlushRef.current())) {
      showNotice('A Markdown vault note could not be saved. Resolve the vault save issue before switching workspaces.')
      return
    }
    const selectedIds = new Set(selected.map((candidate) => candidate.terminalId))
    const nextState = {
      ...stateRef.current,
      workspaces: stateRef.current.workspaces.map((item) => ({
        ...item,
        nodes: item.nodes.map((node) => startupResumes.some((candidate) => candidate.terminalId === node.id) && !selectedIds.has(node.id)
          ? { ...node, data: { ...node.data, resumeOnLaunch: false } }
          : node),
      })),
    }
    stateRef.current = nextState
    setState(nextState)
    setStartupResumes(null)
    if (!selected.length) return
    setPage('board')
    setState((current) => ({ ...current, activeWorkspaceId: selected[0].workspaceId }))
    for (const candidate of selected) {
      await startTerminal(candidate.terminalId, candidate.resume, candidate.workspaceId)
    }
  }

  function applyPreset(preset: 'grid' | 'columns' | 'rows') {
    if (!workspace) return
    updateWorkspace(workspace.id, (current) => ({
      ...current,
      nodes: current.nodes.map((node, index) => ({
        ...node,
        position: preset === 'grid'
          ? { x: 260 + (index % 3) * 560, y: 160 + Math.floor(index / 3) * 360 }
          : preset === 'columns'
            ? { x: 220 + (index % 2) * 650, y: 160 + Math.floor(index / 2) * 330 }
            : { x: 280 + Math.floor(index / 3) * 560, y: 140 + (index % 3) * 300 },
      })),
    }))
  }

  function pinCode(path: string, content: string) {
    if (!workspace || content.length > 500_000) { showNotice('This source file is too large to pin to the board.'); return }
    updateWorkspace(workspace.id, (current) => ({ ...current, nodes: [...current.nodes, {
      id: makeId('code'), type: 'boardItem', position: { x: 440 + current.nodes.length * 30, y: 210 + current.nodes.length * 35 }, style: { width: 540 },
      data: { kind: 'code', title: path.split('/').pop() || path, filePath: path, content },
    }] }))
    setPage('board')
  }

  function addImage(dataUrl: string, name: string, position: XYPosition) {
    if (!workspace || dataUrl.length > 1_500_000) { showNotice('Choose an image smaller than 1 MB.'); return }
    updateWorkspace(workspace.id, (current) => ({ ...current, nodes: [...current.nodes, {
      id: makeId('image'), type: 'boardItem', position, style: { width: 390 },
      data: { kind: 'image', title: name, imageData: dataUrl, strokes: [] },
    }] }))
  }

  function pinDiagram(svg: string) {
    if (!workspace || svg.length > 1_000_000) { showNotice('This diagram is too large to pin to the board.'); return }
    updateWorkspace(workspace.id, (current) => ({ ...current, nodes: [...current.nodes, {
      id: makeId('diagram'), type: 'boardItem', position: { x: 420 + current.nodes.length * 25, y: 240 + current.nodes.length * 25 }, style: { width: 600 },
      data: { kind: 'diagram', title: `${workspace.name} map`, diagramSvg: svg },
    }] }))
    setPage('board')
  }

  function saveVault(documents: Workspace['vault']) {
    if (workspace) updateWorkspace(workspace.id, (current) => ({ ...current, vault: documents }))
  }

  async function switchWorkspace(workspaceId: string) {
    if (workspaceId === stateRef.current.activeWorkspaceId) return
    if (!(await vaultFlushRef.current())) {
      showNotice('A Markdown vault note could not be saved. Resolve the vault save issue before switching workspaces.')
      return
    }
    setState((current) => ({ ...current, activeWorkspaceId: workspaceId }))
    setPage('board')
  }

  const runtime: BoardRuntime = { workspacePath: workspace?.path ?? null, statuses, messages, startTerminal, stopTerminal, setStatus, removeNode, editTerminal, updateNode, addTerminal, sendText, prepareHandoff, getOutput, openGit: () => setPage('git') }

  function addNode(kind: ItemKind) {
    if (!workspace) return
    if (kind === 'terminal') {
      setTerminalDraft({ title: 'Shell', command: 'bash', argsText: '', resumeArgsText: '', cwd: workspace.path ?? '' })
      return
    }
    const id = makeId(kind)
    const base = {
      id,
      type: 'boardItem' as const,
      position: { x: 440 + (workspace.nodes.length % 4) * 80, y: 250 + workspace.nodes.length * 42 },
    }
    let node: BoardItem
    if (kind === 'note' || kind === 'text') node = { ...base, style: { width: 320 }, data: { kind, title: kind === 'text' ? 'Text' : 'New note', content: '' } }
    else if (kind === 'checklist') node = { ...base, style: { width: 320 }, data: { kind, title: 'Tasks', items: [] } }
    else if (kind === 'kanban') node = { ...base, style: { width: 460 }, data: { kind, title: 'Kanban', tasks: [] } }
    else if (kind === 'calendar') node = { ...base, style: { width: 350 }, data: { kind, title: 'Calendar', events: [] } }
    else if (kind === 'drawing') node = { ...base, style: { width: 360 }, data: { kind, title: 'Sketch', strokes: [] } }
    else if (kind === 'git') node = { ...base, style: { width: 400 }, data: { kind, title: 'Repository status' } }
    else node = { ...base, style: { width: 440 }, data: { kind, title: 'Web preview', url: '' } }
    updateWorkspace(workspace.id, (current) => ({ ...current, nodes: [...current.nodes, node] }))
    setPage('board')
  }

  function applyVoiceActions(actions: VoiceAction[]) {
    if (!workspace) return
    const prepared = actions.slice(0, 8).map((action, index) => {
      const id = makeId(action.kind)
      const position = { x: 440 + ((workspace.nodes.length + index) % 4) * 80, y: 250 + (workspace.nodes.length + index) * 42 }
      const title = action.title.trim().slice(0, 120) || (action.kind === 'note' ? 'Voice note' : action.kind === 'checklist' ? 'Voice checklist' : 'Voice kanban')
      if (action.kind === 'note') return { id, type: 'boardItem' as const, position, style: { width: 320 }, data: { kind: 'note' as const, title, content: action.content.slice(0, 4000) } }
      if (action.kind === 'checklist') return { id, type: 'boardItem' as const, position, style: { width: 320 }, data: { kind: 'checklist' as const, title, items: action.items.slice(0, 30).map((text) => ({ id: makeId('check'), text: text.slice(0, 500), done: false })) } }
      return { id, type: 'boardItem' as const, position, style: { width: 460 }, data: { kind: 'kanban' as const, title, tasks: action.tasks.slice(0, 30).map(({ text, status }) => ({ id: makeId('task'), text: text.slice(0, 500), status })) } }
    })
    updateWorkspace(workspace.id, (current) => ({ ...current, nodes: [...current.nodes, ...prepared] }))
    setPage('board')
    showNotice(`${prepared.length} ${prepared.length === 1 ? 'item' : 'items'} added to the board.`)
  }

  async function openProject() {
    try {
      const path = await chooseFolder()
      if (closingRef.current) return
      if (!path) return
      const segments = path.split('/').filter(Boolean)
      const name = segments[segments.length - 1] || 'Project'
      const existing = stateRef.current.workspaces.find((item) => item.path === path)
      if (existing?.id !== stateRef.current.activeWorkspaceId && !(await vaultFlushRef.current())) {
        showNotice('A Markdown vault note could not be saved. Resolve the vault save issue before switching workspaces.')
        return
      }
      if (existing) {
        setState((current) => ({ ...current, activeWorkspaceId: existing.id }))
        setPage('board')
        return
      }
      const next = createWorkspace(name, path)
      setState((current) => ({ ...current, activeWorkspaceId: next.id, workspaces: [...current.workspaces, next] }))
      setPage('board')
      showNotice(`Opened ${name}`)
    } catch (error) {
      showNotice(`Could not open project: ${String(error)}`)
    }
  }

  function saveTerminalDraft() {
    if (!terminalDraft) return
    const command = terminalDraft.command.trim() || 'bash'
    const args = terminalDraft.argsText.split('\n').map((line) => line.trim()).filter(Boolean)
    if (terminalDraft.id) {
      updateNode(terminalDraft.id, (data) => ({
        ...data,
        title: terminalDraft.title.trim() || 'Terminal',
        command,
        sessionId: data.command === command ? data.sessionId : createCliSessionId(command),
        args,
        resumeArgs: terminalDraft.resumeArgsText.split('\n').map((line) => line.trim()).filter(Boolean),
        cwd: terminalDraft.cwd.trim() || undefined,
        profileId: terminalDraft.profileId,
      }))
    } else {
      const activeId = stateRef.current.activeWorkspaceId
      updateWorkspace(activeId, (current) => ({
        ...current,
        nodes: [...current.nodes, {
          id: makeId('terminal'),
          type: 'boardItem',
          position: { x: 390 + (current.nodes.length % 3) * 90, y: 240 + current.nodes.length * 42 },
          style: { width: 500 },
          data: {
            kind: 'terminal',
            title: terminalDraft.title.trim() || 'Terminal',
            command,
            args,
            resumeArgs: terminalDraft.resumeArgsText.split('\n').map((line) => line.trim()).filter(Boolean),
            cwd: terminalDraft.cwd.trim() || undefined,
            profileId: terminalDraft.profileId,
            sessionId: createCliSessionId(command),
          },
        }],
      }))
    }
    setTerminalDraft(null)
    setPage('board')
  }

  function createTeam(team: Team) {
    setState((current) => ({ ...current, teams: [...current.teams, team] }))
    setTeamDialog(false)
  }

  async function createProfile(profile: CliProfile) {
    try {
      if (inDesktopApp) await invoke('create_cli_profile', { id: profile.id })
      setState((current) => ({ ...current, profiles: [...current.profiles, profile] }))
      showNotice(`Isolated profile “${profile.name}” is ready. Sign in to it from its terminal.`)
    } catch (error) {
      showNotice(`Could not create isolated profile: ${String(error)}`)
    }
  }

  function createLoop(input: Pick<LoopRule, 'name' | 'terminalId' | 'trigger' | 'intervalMinutes' | 'outputMatch' | 'prompt' | 'goal' | 'maxRuns'>) {
    const now = Date.now()
    setState((current) => ({ ...current, loops: [...current.loops, {
      ...input, id: makeId('loop'), workspaceId: workspace.id, runs: 0, createdAt: now,
      lastOutputSequence: outputSequenceRef.current[input.terminalId] ?? 0,
      enabled: true, goalMet: false, completionCandidate: false, pending: false,
    }] }))
    setLoopDialog(false)
  }

  function changeApprovalMode(mode: 'default' | 'edits' | 'all') {
    if (mode === 'all' && !window.confirm('Enable auto-approval for all actions in every supported CLI session? This can let agents run commands and modify or delete files without asking.')) return
    setState((current) => ({ ...current, approvalMode: mode }))
  }

  function updateLoop(id: string, update: Partial<LoopRule>) {
    setState((current) => ({ ...current, loops: current.loops.map((loop) => loop.id === id ? { ...loop, ...update } : loop) }))
  }

  function removeLoop(id: string) {
    setState((current) => ({ ...current, loops: current.loops.filter((loop) => loop.id !== id) }))
  }

  async function prepareLoop(loop: LoopRule) {
    if (!loop.pending || statusesRef.current[loop.terminalId] !== 'running') return
    const marker = `[MEGAVIBE_LOOP_GOAL_COMPLETE:${loop.id}]`
    const preparedPrompt = `${loop.prompt}\n\nGoal: ${loop.goal}\nWhen the goal is fully complete, print this exact marker on its own line: ${marker}\nMegavibe will flag the marker for review; the user confirms completion. Do not print the marker before the goal is complete.`
    if (await sendText(loop.terminalId, preparedPrompt)) updateLoop(loop.id, { pending: false })
  }

  function saveMemory(kind: 'project' | 'global', value: string) {
    if (kind === 'global') setState((current) => ({ ...current, globalMemory: value }))
    else updateWorkspace(workspace.id, (current) => ({ ...current, projectMemory: value }))
  }

  function pushMemory(targetId: string, kind: 'project' | 'global'): Promise<boolean> {
    const values = kind === 'global'
      ? stateRef.current.globalMemory
      : stateRef.current.workspaces.find((item) => item.id === stateRef.current.activeWorkspaceId)?.projectMemory ?? ''
    if (!values.trim()) return Promise.resolve(false)
    return sendText(targetId, `\n\n--- ${kind === 'global' ? 'Global' : 'Project'} memory ---\n${values}\n--- End memory ---\n`)
  }

  function addTeamMember(teamId: string) {
    setState((current) => ({
      ...current,
      teams: current.teams.map((team) => team.id === teamId ? {
        ...team,
        members: [...team.members, { id: makeId('member'), name: `Member ${team.members.length + 1}`, cli: 'Shell' }],
      } : team),
    }))
  }

  function updateTeam(teamId: string, update: Partial<Team>) {
    setState((current) => ({ ...current, teams: current.teams.map((team) => team.id === teamId ? { ...team, ...update } : team) }))
  }

  function updateTeamMember(teamId: string, memberId: string, update: Partial<TeamMember>) {
    setState((current) => ({
      ...current,
      teams: current.teams.map((team) => team.id === teamId ? {
        ...team,
        members: team.members.map((member) => member.id === memberId ? { ...member, ...update } : member),
      } : team),
    }))
  }

  function placeTeam(team: Team) {
    for (const member of team.members) addTerminal(cliCommands[member.cli], member.name, team.name)
    setPage('board')
    showNotice(`${team.members.length} ${team.members.length === 1 ? 'console' : 'consoles'} added to the board. Start each when you’re ready.`)
  }

  if (!loaded) {
    return <div className="loading-screen"><div className="brand-mark">m</div><p>Opening your local workspace…</p></div>
  }

  if (loadError) {
    return <div className="loading-screen load-error" role="alert"><div className="brand-mark">m</div><h1>Could not open the local workspace</h1><p>{loadError}</p><p>The saved file was left untouched. Retry after resolving the local storage issue.</p><button className="button button-primary" onClick={() => { setLoadError(null); setLoaded(false); setLoadAttempt((attempt) => attempt + 1) }}>Retry loading</button></div>
  }

  return (
    <BoardRuntimeProvider value={runtime}>
      <div className="app-shell" inert={closing}>
        <aside className="side-rail">
          <div className="brand-mark" title="Megavibe">m</div>
          <div className="rail-rule" />
          <button className={`rail-button ${page === 'board' ? 'active' : ''}`} aria-label="Board" title="Board" onClick={() => setPage('board')}><span>▦</span></button>
          <button className={`rail-button ${page === 'voice' ? 'active' : ''}`} aria-label="Voice planner" title="Voice planner" onClick={() => setPage('voice')}><span>◖</span></button>
          <button className={`rail-button ${page === 'teams' ? 'active' : ''}`} aria-label="Teams" title="Teams" onClick={() => setPage('teams')}><span>♧</span></button>
          <button className={`rail-button ${page === 'studios' ? 'active' : ''}`} aria-label="Studios" title="Studios" onClick={() => setPage('studios')}><span>▤</span></button>
          <button className={`rail-button ${page === 'git' ? 'active' : ''}`} aria-label="Git" title="Git status" onClick={() => setPage('git')}><span>⌘</span></button>
          <div className="rail-spacer" />
          <button className={`rail-button ${page === 'usage' ? 'active' : ''}`} aria-label="Usage" title="Local activity" onClick={() => setPage('usage')}><span>◷</span></button>
          <button className={`rail-button ${page === 'memory' ? 'active' : ''}`} aria-label="Memory" title="Project memory" onClick={() => setPage('memory')}><span>▧</span></button>
          <button className={`rail-button ${page === 'profiles' ? 'active' : ''}`} aria-label="CLI profiles" title="CLI profiles" onClick={() => setPage('profiles')}><span>◎</span></button>
          <button className={`rail-button ${page === 'loops' ? 'active' : ''}`} aria-label="Loops" title="Prompt loops" onClick={() => setPage('loops')}><span>↻</span></button>
          <div className="rail-avatar">C</div>
        </aside>

        <main className="app-main">
          <header className="topbar">
            <div className="workspace-picker-wrap" ref={workspaceMenuRef}>
              <button className="workspace-picker" aria-haspopup="menu" aria-expanded={workspaceMenuOpen} onClick={() => setWorkspaceMenuOpen((open) => !open)}>
                <span className="project-glyph">◈</span>
                <span className="workspace-picker-label"><strong>{workspace?.name ?? 'Workspace'}</strong><small>{workspace?.path ?? 'Personal workspace'}</small></span>
                <span className="chevron">⌄</span>
              </button>
              <div className={`workspace-menu ${workspaceMenuOpen ? 'show' : ''}`}>
                {state.workspaces.map((item) => <button key={item.id} onClick={() => {
                  void switchWorkspace(item.id)
                  setWorkspaceMenuOpen(false)
                }}><span>{item.id === state.activeWorkspaceId ? '●' : '○'}</span><span>{item.name}</span><small>{item.path || 'personal'}</small></button>)}
                <button className="menu-add" onClick={() => { setWorkspaceMenuOpen(false); void openProject() }}><span>＋</span><span>Open project folder…</span></button>
              </div>
            </div>
            <nav className="primary-nav" aria-label="Workspace sections">
              {(['board', 'voice', 'teams', 'studios', 'git', 'usage', 'memory', 'profiles', 'loops', 'settings'] as Page[]).map((item) => <button key={item} className={page === item ? 'selected' : ''} aria-current={page === item ? 'page' : undefined} onClick={() => setPage(item)}>{item === 'git' ? 'Git' : item === 'voice' ? 'Voice' : item[0].toUpperCase() + item.slice(1)}</button>)}
            </nav>
            <div className="topbar-right">
              <span className={`save-indicator ${saving}`}><i />{saving === 'saving' ? 'Saving' : saving === 'error' ? 'Save issue' : 'Local save'}</span>
              <button className="button button-outline" onClick={() => void openProject()}><span>＋</span> Open project</button>
              <button className="button button-primary" onClick={() => { setTerminalDraft({ title: 'Shell', command: 'bash', argsText: '', resumeArgsText: '', cwd: workspace?.path ?? '' }) }}><span>＋</span> New console</button>
            </div>
          </header>

          <section className="page-content">
            {workspace && <div className={`board-layer ${page === 'board' ? '' : 'board-layer-hidden'}`} aria-hidden={page !== 'board'}>
            <BoardPage
              key={workspace.id}
              workspace={workspace}
              statuses={statuses}
              onNotice={showNotice}
              onAddNode={addNode}
              onImageDrop={addImage}
              onOpenBatch={() => setBatchDialog(true)}
              onStartAll={() => void startAllTerminals()}
              onPreset={applyPreset}
              onNodeChanges={(changes) => updateWorkspace(workspace.id, (current) => ({ ...current, nodes: applyNodeChanges(changes, current.nodes) }))}
              onEdgeChanges={(changes) => updateWorkspace(workspace.id, (current) => ({ ...current, edges: applyEdgeChanges(changes, current.edges) }))}
              onConnect={(connection) => updateWorkspace(workspace.id, (current) => ({ ...current, edges: addEdge(connection, current.edges) }))}
              onViewport={(viewport) => updateWorkspace(workspace.id, (current) => ({ ...current, viewport }))}
            />
            </div>}
            {page === 'teams' && <TeamsPage teams={state.teams} workspace={workspace!} statuses={statuses} missionStatuses={missionStatuses} onMention={setTeamMentionTarget} onMissionState={(id, missionState) => updateNode(id, (data) => ({ ...data, missionState }))} onCreate={() => setTeamDialog(true)} onAddMember={addTeamMember} onUpdateMember={updateTeamMember} onUpdateTeam={updateTeam} onPlace={placeTeam} />}
            {workspace && <div className={`studio-layer ${page === 'studios' ? '' : 'studio-layer-hidden'}`} aria-hidden={page !== 'studios'}><StudioWorkspacePage workspace={workspace} onAdd={() => addNode('note')} onUpdate={updateNode} onOpenBoard={() => setPage('board')} onVaultChange={saveVault} onRegisterVaultFlush={registerVaultFlush} onPinCode={pinCode} onPinDiagram={pinDiagram} /></div>}
            {page === 'git' && workspace && <GitPage workspace={workspace} onOpenProject={() => void openProject()} />}
            {page === 'voice' && <VoiceWorkspacePage boardContext={voiceBoardContext} onApply={applyVoiceActions} />}
            {page === 'usage' && <UsageDashboard profiles={state.profiles} />}
            {page === 'memory' && workspace && <MemoryPage workspace={workspace} globalMemory={state.globalMemory} terminals={workspace.nodes.filter((node) => node.data.kind === 'terminal' && statuses[node.id] === 'running')} onSave={saveMemory} onPush={pushMemory} />}
            {page === 'profiles' && <ProfilesPage profiles={state.profiles} onCreate={createProfile} />}
            {page === 'loops' && workspace && <LoopsPage loops={state.loops.filter((loop) => loop.workspaceId === workspace.id)} terminals={workspace.nodes.filter((node) => node.data.kind === 'terminal')} statuses={statuses} onCreate={() => setLoopDialog(true)} onUpdate={updateLoop} onPrepare={prepareLoop} onRemove={removeLoop} />}
            {page === 'settings' && <SettingsPage mode={state.approvalMode ?? 'default'} onModeChange={changeApprovalMode} />}
          </section>
        </main>

        {terminalDraft && <TerminalDialog
          draft={terminalDraft}
          setDraft={setTerminalDraft}
          onClose={() => setTerminalDraft(null)}
          onSave={saveTerminalDraft}
          profiles={state.profiles}
        />}
        {teamDialog && <TeamDialog onClose={() => setTeamDialog(false)} onSave={createTeam} />}
        {teamMentionTarget && workspace && <TeamMentionDialog sourceId={teamMentionTarget} workspace={workspace} statuses={statuses} onClose={() => setTeamMentionTarget(null)} onSend={sendText} />}
        {batchDialog && <BatchDialog onClose={() => setBatchDialog(false)} onAdd={addBatch} />}
        {loopDialog && workspace && <LoopDialog terminals={workspace.nodes.filter((node) => node.data.kind === 'terminal')} onClose={() => setLoopDialog(false)} onSave={createLoop} />}
        {handoffSource && workspace && <HandoffDialog sourceId={handoffSource} workspace={workspace} statuses={statuses} output={getOutput(handoffSource)} onClose={() => setHandoffSource(null)} onSend={sendText} />}
        {notice && <div className="toast" role="status">{notice}<button onClick={() => setNotice('')} aria-label="Dismiss">×</button></div>}
        {startupResumes && <StartupResumeDialog
          candidates={startupResumes}
          selectedIds={selectedResumeIds}
          onToggle={(id) => setSelectedResumeIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])}
          onStart={() => void startSavedTerminals(selectedResumeIds)}
          onLater={() => setStartupResumes(null)}
        />}
      </div>
      {closing && <div className="closing-overlay" role="status" aria-live="polite"><div className="brand-mark">m</div><strong>Saving workspace and closing Megavibe…</strong></div>}
    </BoardRuntimeProvider>
  )
}

function BoardPage({
  workspace,
  statuses,
  onNotice,
  onAddNode,
  onImageDrop,
  onOpenBatch,
  onStartAll,
  onPreset,
  onNodeChanges,
  onEdgeChanges,
  onConnect,
  onViewport,
}: {
  workspace: Workspace
  statuses: Record<string, RuntimeStatus>
  onNotice: (text: string) => void
  onAddNode: (kind: ItemKind) => void
  onImageDrop: (dataUrl: string, name: string, position: XYPosition) => void
  onOpenBatch: () => void
  onStartAll: () => void
  onPreset: (preset: 'grid' | 'columns' | 'rows') => void
  onNodeChanges: (changes: NodeChange<BoardItem>[]) => void
  onEdgeChanges: (changes: EdgeChange[]) => void
  onConnect: (connection: Connection) => void
  onViewport: (viewport: Workspace['viewport']) => void
}) {
  const { fitView, zoomIn, zoomOut, screenToFlowPosition } = useReactFlow<BoardItem>()
  const activeTerminals = workspace.nodes.filter((node) => node.data.kind === 'terminal' && statuses[node.id] === 'running').length
  const [toolsOpen, setToolsOpen] = useState(false)
  const [presetsOpen, setPresetsOpen] = useState(false)
  const imagePicker = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (!toolsOpen && !presetsOpen) return
    const close = (event: MouseEvent) => {
      if (!(event.target as HTMLElement).closest('.tool-menu-wrap')) { setToolsOpen(false); setPresetsOpen(false) }
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setToolsOpen(false); setPresetsOpen(false) }
    }
    document.addEventListener('mousedown', close)
    window.addEventListener('keydown', escape)
    return () => {
      document.removeEventListener('mousedown', close)
      window.removeEventListener('keydown', escape)
    }
  }, [toolsOpen, presetsOpen])
  function importImage(file: File, position: XYPosition) {
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type) || file.size > 1024 * 1024) {
      onNotice('Choose a PNG, JPEG, WebP, or GIF image smaller than 1 MB.')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') onImageDrop(reader.result, file.name, position)
    }
    reader.readAsDataURL(file)
  }
  function imageAtCenter(file: File) {
    const bounds = document.querySelector('.board-canvas')?.getBoundingClientRect()
    if (!bounds) return
    importImage(file, screenToFlowPosition({ x: bounds.left + bounds.width / 2, y: bounds.top + bounds.height / 2 }))
  }
  return (
    <div className="board-page">
      <div className="board-toolbar">
        <div className="board-heading"><span className="board-icon">▦</span><div><strong>{workspace.name}</strong><small>{workspace.nodes.length} cards · {activeTerminals} active {activeTerminals === 1 ? 'console' : 'consoles'}</small></div></div>
        <div className="board-path"><span className="path-dot" />{workspace.path ? <><span className="path-root">project</span><span>/</span><strong>{workspace.path}</strong></> : <span>Personal workspace</span>}</div>
        <div className="board-toolbar-actions">
          <div className="tool-menu-wrap">
            <button className="button button-outline" aria-haspopup="menu" aria-expanded={toolsOpen} onClick={() => setToolsOpen(!toolsOpen)}><span>＋</span> Add card <span className="chevron">⌄</span></button>
            {toolsOpen && <div className="add-card-menu">
              <button onClick={() => { onAddNode('terminal'); setToolsOpen(false) }}><b className="menu-icon terminal">⌘</b><span><strong>Terminal</strong><small>Run a local CLI</small></span></button>
              <button onClick={() => { onAddNode('note'); setToolsOpen(false) }}><b className="menu-icon note">✎</b><span><strong>Note</strong><small>Keep context on the board</small></span></button>
              <button onClick={() => { onAddNode('checklist'); setToolsOpen(false) }}><b className="menu-icon list">☑</b><span><strong>Checklist</strong><small>Track project work</small></span></button>
              <button onClick={() => { onAddNode('kanban'); setToolsOpen(false) }}><b className="menu-icon list">▦</b><span><strong>Kanban</strong><small>Move cards across stages</small></span></button>
              <button onClick={() => { onAddNode('text'); setToolsOpen(false) }}><b className="menu-icon note">T</b><span><strong>Text block</strong><small>Pin freeform context</small></span></button>
              <button onClick={() => { onAddNode('calendar'); setToolsOpen(false) }}><b className="menu-icon preview">▣</b><span><strong>Calendar</strong><small>Track dated milestones</small></span></button>
              <button onClick={() => { onAddNode('drawing'); setToolsOpen(false) }}><b className="menu-icon note">✳</b><span><strong>Drawing</strong><small>Sketch directly on the board</small></span></button>
              <button onClick={() => { imagePicker.current?.click(); setToolsOpen(false) }}><b className="menu-icon note">▧</b><span><strong>Image markup</strong><small>Annotate a local image</small></span></button>
              <button onClick={() => { onAddNode('preview'); setToolsOpen(false) }}><b className="menu-icon preview">↗</b><span><strong>Web preview</strong><small>Pin a local or web URL</small></span></button>
              <button onClick={() => { onAddNode('git'); setToolsOpen(false) }}><b className="menu-icon git">⑂</b><span><strong>Git status</strong><small>Keep local changes on the board</small></span></button>
            </div>}
          </div>
          <button className="button button-outline" onClick={onOpenBatch}>Batch composer</button>
          <button className="button button-outline" onClick={onStartAll} disabled={!workspace.nodes.some((node) => node.data.kind === 'terminal')}>Start all</button>
          <div className="tool-menu-wrap"><button className="button button-outline" aria-haspopup="menu" aria-expanded={presetsOpen} onClick={() => setPresetsOpen(!presetsOpen)}>Presets <span className="chevron">⌄</span></button>{presetsOpen && <div className="add-card-menu layout-menu">{(['grid', 'columns', 'rows'] as const).map((preset) => <button key={preset} onClick={() => { onPreset(preset); setPresetsOpen(false) }}><b className="menu-icon preview">▦</b><span><strong>{preset === 'grid' ? 'Balanced grid' : preset === 'columns' ? 'Two columns' : 'Three rows'}</strong><small>Rearrange board cards</small></span></button>)}</div>}</div>
          <span className="toolbar-divider" />
          <button className="quiet-icon" onClick={() => zoomOut()} title="Zoom out">−</button>
          <button className="quiet-icon" onClick={() => fitView({ padding: 0.24, duration: 250 })} title="Fit board">⌗</button>
          <button className="quiet-icon" onClick={() => zoomIn()} title="Zoom in">＋</button>
        </div>
      </div>
      <div className="board-canvas">
        <ReactFlow
          nodes={workspace.nodes}
          edges={workspace.edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodeChanges}
          onEdgesChange={onEdgeChanges}
          onConnect={onConnect}
          onDragOver={(event) => { if (event.dataTransfer.types.includes('Files')) { event.preventDefault(); event.dataTransfer.dropEffect = 'copy' } }}
          onDrop={(event) => {
            if (!event.dataTransfer.files.length) return
            event.preventDefault()
            const file = event.dataTransfer.files[0]
            importImage(file, screenToFlowPosition({ x: event.clientX, y: event.clientY }))
          }}
          onMoveEnd={(_event, viewport) => onViewport(viewport)}
          defaultViewport={workspace.viewport ?? { x: 0, y: 0, zoom: 1 }}
          minZoom={0.2}
          maxZoom={1.5}
          fitView={false}
          deleteKeyCode={null}
          proOptions={{ hideAttribution: true }}
          connectionLineStyle={{ stroke: '#f17b4c', strokeWidth: 1.5 }}
          defaultEdgeOptions={{ animated: false, style: { stroke: '#6c5144', strokeWidth: 1.5 } }}
        >
          <Background color="#282a2d" gap={19} size={1.1} />
          <Controls position="bottom-left" showInteractive={false} />
          <MiniMap position="bottom-right" pannable zoomable nodeColor={(node) => {
            const item = node.data as BoardItemData
            return item.kind === 'terminal' ? '#f17b4c' : item.kind === 'note' ? '#d4bb91' : item.kind === 'checklist' ? '#85a89a' : '#879bc4'
          }} maskColor="rgba(8, 9, 11, .75)" />
        </ReactFlow>
        <input ref={imagePicker} type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden onChange={(event) => { const file = event.target.files?.[0]; if (file) imageAtCenter(file); event.target.value = '' }} />
        {workspace.nodes.length === 0 && <div className="empty-board"><div className="empty-board-mark">⌘</div><h2>A clear board, ready for your project.</h2><p>Add consoles, notes, and checklists, then arrange them around the work.</p><button className="button button-primary" onClick={() => onAddNode('terminal')}>＋ Add a console</button></div>}
        <div className="canvas-legend"><span><i className="legend-live" /> local process</span><span><i className="legend-note" /> planning card</span><span>Drag the canvas to move around</span></div>
      </div>
    </div>
  )
}

function TerminalDialog({ draft, setDraft, onClose, onSave, profiles }: {
  draft: TerminalDraft
  setDraft: (draft: TerminalDraft | null) => void
  onClose: () => void
  onSave: () => void
  profiles: CliProfile[]
}) {
  useEscapeKey(onClose)
  useEscapeKey(onClose)
  const [folderBusy, setFolderBusy] = useState(false)
  async function browse() {
    setFolderBusy(true)
    try {
      const path = await chooseFolder()
      if (path) setDraft({ ...draft, cwd: path })
    } catch {
      // The directory field remains editable if the native picker is unavailable.
    } finally {
      setFolderBusy(false)
    }
  }
  const commandName = draft.command.split('/').pop()?.toLowerCase()
  const matchingProfiles = profiles.filter((profile) => profile.command === '*' || profile.command.toLowerCase() === commandName)
  return (
    <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <form className="modal-card" onSubmit={(event) => { event.preventDefault(); onSave() }}>
        <div className="modal-header"><div className="modal-badge">⌘</div><div><h2>{draft.id ? 'Configure console' : 'New console'}</h2><p>Choose a local command and working folder.</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close">×</button></div>
        <label className="form-label">Console name<input autoFocus value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} placeholder="Builder" /></label>
        <label className="form-label">Command
          <div className="command-entry"><span className="command-prompt">$</span><input value={draft.command} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="claude" /></div>
        </label>
        <div className="preset-row">{CLI_PRESETS.map((preset) => <button type="button" key={preset.command} className={draft.command === preset.command ? 'selected' : ''} onClick={() => setDraft({ ...draft, command: preset.command, title: draft.title === 'Shell' || draft.title === 'Terminal' ? preset.label : draft.title })}>{preset.label}</button>)}</div>
        <label className="form-label">Arguments <small>One argument per line. Arguments are passed directly to the command.</small><textarea className="args-field" value={draft.argsText} onChange={(event) => setDraft({ ...draft, argsText: event.target.value })} placeholder={'--help\n--verbose'} /></label>
        <label className="form-label">Resume arguments <small>Optional custom resume arguments, one per line. Leave blank for Claude/Gemini session IDs or Codex's session picker.</small><textarea className="args-field" value={draft.resumeArgsText} onChange={(event) => setDraft({ ...draft, resumeArgsText: event.target.value })} placeholder="Custom resume arguments" /></label>
        <label className="form-label">Account profile <small>Optional isolated CLI home. Create and sign in to profiles from CLI profiles.</small><select value={draft.profileId ?? ''} onChange={(event) => setDraft({ ...draft, profileId: event.target.value || undefined })}><option value="">Use normal account</option>{matchingProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}</select></label>
        <label className="form-label">Working folder<div className="folder-entry"><input value={draft.cwd} onChange={(event) => setDraft({ ...draft, cwd: event.target.value })} placeholder="Use the project folder or your home directory" /><button type="button" className="button button-outline" onClick={() => void browse()} disabled={!inDesktopApp || folderBusy}>{folderBusy ? '…' : 'Browse'}</button></div></label>
        <div className="modal-note"><span>◉</span><p>The command runs on this machine in its own interactive console. It starts only when you press <strong>Run console</strong>.</p></div>
        <div className="modal-footer"><button type="button" className="button button-outline" onClick={onClose}>Cancel</button><button type="submit" className="button button-primary">Save console</button></div>
      </form>
    </div>
  )
}

function StartupResumeDialog({ candidates, selectedIds, onToggle, onStart, onLater }: {
  candidates: StartupResumeCandidate[]
  selectedIds: string[]
  onToggle: (id: string) => void
  onStart: () => void
  onLater: () => void
}) {
  useEscapeKey(onLater)
  useEscapeKey(onLater)
  const selected = candidates.filter((candidate) => selectedIds.includes(candidate.terminalId))
  const allResume = selected.length > 0 && selected.every((candidate) => candidate.resume)
  return (
    <div className="modal-backdrop startup-resume-backdrop">
      <section className="modal-card startup-resume-dialog" role="dialog" aria-modal="true" aria-labelledby="resume-dialog-title">
        <div className="modal-header"><div className="modal-badge">↻</div><div><h2 id="resume-dialog-title">Pick up where you left off</h2><p>These local consoles were running when Megavibe last closed.</p></div></div>
        <div className="resume-list">{candidates.map((candidate) => <label className="resume-row" key={candidate.terminalId}>
          <input type="checkbox" checked={selectedIds.includes(candidate.terminalId)} onChange={() => onToggle(candidate.terminalId)} />
          <span className="resume-copy"><strong>{candidate.title}</strong><small title={`${candidate.workspaceName} · ${candidate.command} · ${candidate.profileName} · ${candidate.cwd}`}>{candidate.workspaceName} · {candidate.command} · {candidate.profileName} · {candidate.cwd}</small></span>
          <span className="resume-mode">{candidate.resume ? candidate.command.split('/').pop()?.toLowerCase() === 'codex' ? 'Choose a Codex session' : 'Resume last session' : 'Start console'}</span>
        </label>)}</div>
        <div className="modal-note"><span>◉</span><p>Nothing starts until you choose. Codex opens its session picker; Claude and Gemini use their saved session IDs. Other consoles start with their saved command and arguments.</p></div>
        <div className="modal-footer"><button type="button" className="button button-outline" onClick={onLater}>Later</button><button type="button" className="button button-primary" onClick={onStart} disabled={!selected.length}>{allResume ? 'Resume selected' : selected.some((candidate) => candidate.resume) ? 'Start / resume selected' : 'Start selected'}</button></div>
      </section>
    </div>
  )
}

function TeamsPage({ teams, workspace, statuses, missionStatuses, onMention, onMissionState, onCreate, onAddMember, onUpdateMember, onUpdateTeam, onPlace }: {
  teams: Team[]
  workspace: Workspace
  statuses: Record<string, RuntimeStatus>
  missionStatuses: Record<string, BoardItemData['missionState']>
  onMention: (id: string) => void
  onMissionState: (id: string, missionState: BoardItemData['missionState']) => void
  onCreate: () => void
  onAddMember: (teamId: string) => void
  onUpdateMember: (teamId: string, memberId: string, update: Partial<TeamMember>) => void
  onUpdateTeam: (teamId: string, update: Partial<Team>) => void
  onPlace: (team: Team) => void
}) {
  const terminals = workspace.nodes.filter((node) => node.data.kind === 'terminal')
  function exportReport() {
    const lines = [
      `# Team report — ${workspace.name}`,
      '',
      `Generated locally: ${new Date().toLocaleString()}`,
      '',
      '## Console status',
      ...terminals.map((node) => {
        const state = node.data.missionState ?? missionStatuses[node.id] ?? (statuses[node.id] === 'running' ? 'working' : 'resting')
        return `- **${node.data.title}** — ${state}; process ${statuses[node.id] ?? 'stopped'}; ${node.data.team ?? node.data.command ?? 'local console'}`
      }),
      '',
      '## Team roles',
      ...teams.flatMap((team) => [`### ${team.name}`, team.purpose, ...team.members.map((member) => `- ${member.name} — ${member.cli}`), '']),
    ]
    downloadMarkdown(`${workspace.name.replace(/[^a-z0-9-_]+/gi, '-')}-team-report.md`, lines.join('\n'))
  }
  return (
    <div className="secondary-page teams-page">
      <div className="page-intro"><div><span className="eyebrow">LOCAL CLI CREWS</span><h1>Teams</h1><p>Organize role-based console groups. Each member is a local CLI you choose to start.</p></div><button className="button button-primary" onClick={onCreate}>＋ New team</button></div>
      <section className="mission-map"><div className="panel-heading"><div><h2>Mission map</h2><p>Activity is inferred from recent output and permission prompts; you can set a status manually.</p></div><div className="mission-map-actions"><span className="activity-range">{terminals.length} CONSOLES</span><button className="text-button" onClick={exportReport}>Export team report</button></div></div>{terminals.length ? <div className="mission-list">{terminals.map((node) => { const state = node.data.missionState ?? missionStatuses[node.id] ?? (statuses[node.id] === 'running' ? 'working' : 'resting'); return <div className="mission-row" key={node.id}><span className={`mission-dot ${state}`} /><div><strong>{node.data.title}</strong><small>{node.data.team ?? node.data.command ?? 'local console'} · process {(statuses[node.id] ?? 'stopped').toUpperCase()}</small></div><select value={node.data.missionState ?? ''} aria-label={`Set ${node.data.title} status`} onChange={(event) => onMissionState(node.id, event.target.value ? event.target.value as BoardItemData['missionState'] : undefined)}><option value="">Automatic</option><option value="working">Working</option><option value="resting">Resting</option><option value="needs-you">Needs you</option></select>{statuses[node.id] === 'running' && <button className="text-button" onClick={() => onMention(node.id)}>Prepare @mention</button>}</div> })}</div> : <div className="activity-empty">Add local consoles to see them here.</div>}</section>
      <div className="team-grid">
        {teams.map((team, index) => <article className="team-card" key={team.id}>
          <div className="team-card-top"><div className={`team-symbol team-symbol-${index % 4}`}>♧</div><span className="team-local-tag"><i /> Local</span></div>
          <input className="team-name" value={team.name} aria-label="Team name" onChange={(event) => onUpdateTeam(team.id, { name: event.target.value })} />
          <p className="team-purpose">{team.purpose}</p>
          <div className="team-members-head"><span>MEMBERS</span><span>{team.members.length} roles</span></div>
          <div className="team-members">{team.members.map((member, memberIndex) => <div className="team-member" key={member.id}>
            <span className={`member-avatar member-${memberIndex % 4}`}>{member.name.slice(0, 1).toUpperCase()}</span>
            <input value={member.name} aria-label="Role name" onChange={(event) => onUpdateMember(team.id, member.id, { name: event.target.value })} />
            <select value={member.cli} aria-label="Console CLI" onChange={(event) => onUpdateMember(team.id, member.id, { cli: event.target.value as TeamMember['cli'] })}>{(Object.keys(cliCommands) as TeamMember['cli'][]).map((cli) => <option key={cli} value={cli}>{cli}</option>)}</select>
            <button className="member-add" title={`Add ${member.name} console to board`} onClick={() => onPlace({ ...team, members: [member] })}>＋</button>
          </div>)}</div>
          <div className="team-card-footer"><button className="text-button" onClick={() => onAddMember(team.id)}>＋ Add role</button><button className="button button-outline" onClick={() => onPlace(team)}>Place all on board <span>↗</span></button></div>
        </article>)}
        {teams.length === 0 && <div className="empty-surface"><div className="empty-icon">♧</div><h2>Make a team for your next task</h2><p>A team is a saved set of terminal roles. Megavibe doesn’t start agent processes until you choose to run them.</p><button className="button button-primary" onClick={onCreate}>＋ Create team</button></div>}
      </div>
      <div className="feature-note"><span>◉</span><div><strong>Every member runs locally</strong><p>Choose installed command-line tools for each role. Megavibe stores team setup in your workspace file and never sends team data to a server. @mentions are pasted into another running console for review and are not submitted automatically.</p></div></div>
    </div>
  )
}

function TeamDialog({ onClose, onSave }: { onClose: () => void; onSave: (team: Team) => void }) {
  useEscapeKey(onClose)
  useEscapeKey(onClose)
  const [name, setName] = useState('New team')
  const [purpose, setPurpose] = useState('A focused crew for this project.')
  function submit(event: FormEvent) {
    event.preventDefault()
    onSave({
      id: makeId('team'),
      name: name.trim() || 'New team',
      purpose: purpose.trim(),
      members: [
        { id: makeId('member'), name: 'Planner', cli: 'Claude Code' },
        { id: makeId('member'), name: 'Builder', cli: 'Codex' },
      ],
    })
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><form className="modal-card compact-modal" onSubmit={submit}>
    <div className="modal-header"><div className="modal-badge team-badge">♧</div><div><h2>Create a team</h2><p>Start with two editable local console roles.</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close">×</button></div>
    <label className="form-label">Team name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label className="form-label">Purpose<input value={purpose} onChange={(event) => setPurpose(event.target.value)} /></label>
    <div className="modal-footer"><button type="button" className="button button-outline" onClick={onClose}>Cancel</button><button className="button button-primary">Create team</button></div>
  </form></div>
}

function TeamMentionDialog({ sourceId, workspace, statuses, onClose, onSend }: {
  sourceId: string
  workspace: Workspace
  statuses: Record<string, RuntimeStatus>
  onClose: () => void
  onSend: (id: string, text: string) => Promise<boolean>
}) {
  const source = workspace.nodes.find((node) => node.id === sourceId)
  const targets = workspace.nodes.filter((node) => node.data.kind === 'terminal' && node.id !== sourceId && statuses[node.id] === 'running')
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '')
  useEscapeKey(onClose)
  const [message, setMessage] = useState('Can you share your current status and next step?')
  const [sending, setSending] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!targetId || !message.trim() || sending) return
    setSending(true)
    try {
      if (await onSend(targetId, `\n\n@${source?.data.title ?? 'team'} ${message.trim()}\n`)) onClose()
    } finally {
      setSending(false)
    }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><form className="modal-card compact-modal" onSubmit={(event) => { void submit(event) }}><div className="modal-header"><div className="modal-badge team-badge">@</div><div><h2>Prepare team @mention</h2><p>Prepare a message for another running team console.</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close">×</button></div><label className="form-label">Mention as<input value={source?.data.title ?? ''} readOnly /></label><label className="form-label">To<select value={targetId} onChange={(event) => setTargetId(event.target.value)}>{targets.map((node) => <option key={node.id} value={node.id}>{node.data.title}</option>)}</select></label><label className="form-label">Message<textarea className="args-field" value={message} onChange={(event) => setMessage(event.target.value)} /></label><div className="modal-note"><span>◉</span><p>The message is pasted into the destination console without pressing Enter. Review it there before submitting.</p></div><div className="modal-footer"><button type="button" className="button button-outline" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={!targetId || !message.trim() || sending}>{sending ? 'Preparing…' : 'Prepare mention'}</button></div></form></div>
}

function BatchDialog({ onClose, onAdd }: { onClose: () => void; onAdd: (items: Array<{ title: string; command: string }>) => void | Promise<void> }) {
  useEscapeKey(onClose)
  const [slots, setSlots] = useState(() => Array.from({ length: 12 }, (_, index) => ({ enabled: index === 0, title: `Console ${index + 1}`, command: 'bash' })))
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><div className="modal-card batch-modal"><div className="modal-header"><div className="modal-badge team-badge">▦</div><div><h2>Batch composer</h2><p>Configure and launch up to twelve local consoles together.</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close">×</button></div><div className="batch-slots">{slots.map((slot, index) => <div className={`batch-slot ${slot.enabled ? 'enabled' : ''}`} key={index}><label><input type="checkbox" checked={slot.enabled} onChange={(event) => setSlots((current) => current.map((item, slotIndex) => slotIndex === index ? { ...item, enabled: event.target.checked } : item))} /><span>#{String(index + 1).padStart(2, '0')}</span></label><input value={slot.title} aria-label={`Console ${index + 1} name`} onChange={(event) => setSlots((current) => current.map((item, slotIndex) => slotIndex === index ? { ...item, title: event.target.value } : item))} disabled={!slot.enabled} /><select value={slot.command} aria-label={`Console ${index + 1} CLI`} onChange={(event) => setSlots((current) => current.map((item, slotIndex) => slotIndex === index ? { ...item, command: event.target.value } : item))} disabled={!slot.enabled}>{CLI_PRESETS.map((preset) => <option key={preset.command} value={preset.command}>{preset.label}</option>)}</select></div>)}</div><div className="modal-footer"><span className="batch-count">{slots.filter((slot) => slot.enabled).length} / 12 selected</span><button type="button" className="button button-outline" onClick={onClose}>Cancel</button><button type="button" className="button button-primary" disabled={!slots.some((slot) => slot.enabled)} onClick={() => void onAdd(slots.filter((slot) => slot.enabled).map(({ title, command }) => ({ title: title.trim() || 'Console', command })))}>Launch selected</button></div></div></div>
}

function GitPage({ workspace, onOpenProject }: { workspace: Workspace; onOpenProject: () => void }) {
  const [status, setStatus] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(false)
  const [actionMessage, setActionMessage] = useState('')
  const [commitMessage, setCommitMessage] = useState('')
  const [githubSummary, setGithubSummary] = useState<{ repository: string; pullRequests: Array<{ number: number; title: string; state: string; url: string; author?: { login?: string } }>; issues: Array<{ number: number; title: string; state: string; url: string; author?: { login?: string } }> } | null>(null)
  const [githubError, setGithubError] = useState('')
  const [githubLoading, setGithubLoading] = useState(false)
  const refresh = useCallback(async () => {
    if (!workspace.path) return
    setLoading(true)
    setError('')
    try {
      const result = await invoke<string>('git_status', { path: workspace.path })
      setStatus(result)
    } catch (reason) {
      setStatus('')
      setError(String(reason))
    } finally {
      setLoading(false)
    }
  }, [workspace.path])
  useEffect(() => { void refresh() }, [refresh])
  async function runAction(action: 'commit' | 'push' | 'pull') {
    if (!workspace.path) return
    if (action === 'push' && !window.confirm('Push the current branch to its configured Git remote?')) return
    if (action === 'pull' && !window.confirm('Pull from the configured Git remote into this project? This can change local files or create merge conflicts.')) return
    setLoading(true)
    setError('')
    setActionMessage('')
    try {
      const result = await invoke<string>('git_action', { path: workspace.path, action, message: action === 'commit' ? commitMessage.trim() : undefined })
      setActionMessage(result || `Git ${action} completed.`)
      if (action === 'commit') setCommitMessage('')
      await refresh()
    } catch (reason) {
      setError(String(reason))
    } finally {
      setLoading(false)
    }
  }
  async function loadGithubActivity() {
    if (!workspace.path || githubLoading) return
    if (!window.confirm('Query GitHub for this repository name and up to 10 open pull requests and issues using your local gh login? Megavibe sends no workspace file contents.')) return
    setGithubLoading(true)
    setGithubError('')
    try {
      const result = await invoke<typeof githubSummary>('github_summary', { path: workspace.path })
      setGithubSummary(result)
    } catch (reason) {
      setGithubError(String(reason))
    } finally {
      setGithubLoading(false)
    }
  }
  const entries = status.split('\n').filter(Boolean)
  const branchLine = entries[0] ?? ''
  const changes = entries.slice(1)
  return <div className="secondary-page git-page">
    <div className="page-intro"><div><span className="eyebrow">LOCAL REPOSITORY</span><h1>Git</h1><p>Review repository state and run explicit local Git actions.</p></div>{workspace.path && <button className="button button-outline" onClick={() => void refresh()} disabled={loading}>{loading ? 'Working…' : '↻ Refresh status'}</button>}</div>
    {!workspace.path ? <div className="empty-surface"><div className="empty-icon">⌘</div><h2>Open a project to see Git status</h2><p>Megavibe runs a local <code>git status</code> check for the selected folder.</p><button className="button button-primary" onClick={onOpenProject}>＋ Open project folder</button></div> : <div className="git-panel">
      <div className="git-panel-head"><div><span className="git-branch-icon">⑂</span><strong>{branchLine.replace(/^##\s*/, '').split('...')[0] || 'Repository status'}</strong></div><span className="git-path-label">{workspace.path}</span></div>
      <div className="git-actions"><label>Commit staged changes<input value={commitMessage} onChange={(event) => setCommitMessage(event.target.value)} placeholder="Commit message" /></label><button className="button button-outline" disabled={loading || !commitMessage.trim()} onClick={() => void runAction('commit')}>Commit</button><span /><button className="button button-outline" disabled={loading} onClick={() => void runAction('pull')}>Pull</button><button className="button button-primary" disabled={loading} onClick={() => void runAction('push')}>Push</button></div>
      {actionMessage && <div className="git-action-message" role="status">{actionMessage}</div>}
      {error ? <div className="git-error"><span>!</span><div><strong>Could not read Git status</strong><p>{error}</p></div></div> : loading && !status ? <div className="git-loading">Checking repository…</div> : !changes.length ? <div className="git-clean"><span>✓</span><div><strong>Working tree clean</strong><p>There are no uncommitted changes.</p></div></div> : <div className="git-change-list">{changes.map((line, index) => <div key={`${line}-${index}`}><span className={`change-mark ${line.slice(0, 2).includes('A') ? 'added' : line.slice(0, 2).includes('D') ? 'deleted' : 'modified'}`}>{line.slice(0, 2).trim() || 'M'}</span><code>{line.slice(3)}</code><span className="change-label">{line.slice(0, 2).trim() || 'modified'}</span></div>)}</div>}
      <div className="git-footer"><span>◉ Local Git</span><span>Uses configured remotes with your installed Git credential helper. Stage files in your usual Git tool before committing.</span></div>
      <section className="github-panel"><div className="panel-heading"><div><h2>GitHub</h2><p>Load remote repository activity only when you request it.</p></div><button className="button button-outline" onClick={() => void loadGithubActivity()} disabled={githubLoading}>{githubLoading ? 'Loading…' : githubSummary ? '↻ Refresh GitHub' : 'Load GitHub activity'}</button></div>{githubError && <div className="git-error"><span>!</span><div><strong>Could not load GitHub activity</strong><p>{githubError}</p></div></div>}{githubSummary && <><div className="github-repository"><span>REPOSITORY</span><strong>{githubSummary.repository}</strong></div><div className="github-lists">{([{ title: 'Pull requests', items: githubSummary.pullRequests }, { title: 'Issues', items: githubSummary.issues }] as const).map((group) => <section key={group.title}><h3>{group.title} <small>{group.items.length}</small></h3>{group.items.length ? group.items.map((item) => <a href={item.url} target="_blank" rel="noreferrer" key={item.number}><span>#{item.number}</span><strong>{item.title}</strong><small>{item.author?.login ?? 'Unknown author'} · {item.state}</small></a>) : <p className="activity-empty">No open {group.title.toLowerCase()}.</p>}</section>)}</div><small className="github-note">GitHub API metadata only · loaded by explicit request · links open in your browser</small></>}</section>
    </div>}
  </div>
}

function SettingsPage({ mode, onModeChange }: { mode: 'default' | 'edits' | 'all'; onModeChange: (mode: 'default' | 'edits' | 'all') => void }) {
  const options: Array<{ value: 'default' | 'edits' | 'all'; title: string; detail: string }> = [
    { value: 'default', title: 'Ask as configured', detail: 'Respect each CLI’s own permission settings.' },
    { value: 'edits', title: 'Auto-approve edits', detail: 'Automatically approve file edits while keeping each CLI’s other safety boundaries.' },
    { value: 'all', title: 'Auto-approve all actions', detail: 'Skip CLI permission prompts. Agents can run commands and change files without asking.' },
  ]
  return <div className="secondary-page settings-page">
    <div className="page-intro"><div><span className="eyebrow">LOCAL PREFERENCES</span><h1>Settings</h1><p>Set permission behavior for newly launched supported CLI sessions.</p></div><span className="local-only-pill"><i /> Stored locally</span></div>
    <section className="settings-panel"><div className="panel-heading"><div><h2>Global auto-approval</h2><p>Applies to Claude Code, Codex, and Gemini CLI when Megavibe starts or resumes a session.</p></div></div><div className="approval-options">{options.map((option) => <label className={`approval-option ${mode === option.value ? 'selected' : ''} ${option.value === 'all' ? 'approval-danger' : ''}`} key={option.value}><input type="radio" name="approval-mode" value={option.value} checked={mode === option.value} onChange={() => onModeChange(option.value)} /><span><strong>{option.title}</strong><small>{option.detail}</small></span></label>)}</div><div className="modal-note"><span>◉</span><p>Default is ask as configured. Custom permission flags in a console’s arguments take precedence. Auto-approval is off for other or custom CLIs.</p></div></section>
  </div>
}

function ProfilesPage({ profiles, onCreate }: { profiles: CliProfile[]; onCreate: (profile: CliProfile) => void }) {
  const [name, setName] = useState('')
  const [command, setCommand] = useState('claude')
  const [creating, setCreating] = useState(false)
  useEscapeKey(() => setCreating(false), creating)
  useEscapeKey(() => setCreating(false), creating)
  function submit(event: FormEvent) {
    event.preventDefault()
    const cleanName = name.trim()
    if (!cleanName) return
    onCreate({ id: makeId('profile'), name: cleanName, command })
    setName('')
    setCreating(false)
  }
  return <div className="secondary-page">
    <div className="page-intro"><div><span className="eyebrow">LOCAL CLI ACCOUNTS</span><h1>Profiles</h1><p>Each profile runs with a private home directory. Sign in to the CLI from that profile’s terminal.</p></div><button className="button button-primary" onClick={() => setCreating(true)}>＋ New profile</button></div>
    <div className="feature-note"><span>◉</span><div><strong>Separate local account state</strong><p>Profiles get private HOME and XDG config, data, and cache folders under Megavibe’s app data directory. Megavibe does not copy credentials from your normal account.</p></div></div>
    {profiles.length ? <div className="studio-grid profile-grid">{profiles.map((profile) => <article className="studio-card" key={profile.id}><div className="studio-card-head"><span>ISOLATED HOME</span><span className="team-local-tag"><i /> Local</span></div><strong className="profile-name">{profile.name}</strong><code>{profile.command === '*' ? 'Any CLI' : profile.command}</code><footer><span>{profile.id}</span><span>Credentials are not copied</span></footer></article>)}</div> : <div className="empty-surface"><div className="empty-icon">◎</div><h2>No isolated profiles yet</h2><p>Create one for each account you want to keep separate, then select it when configuring a console.</p><button className="button button-primary" onClick={() => setCreating(true)}>＋ Create a profile</button></div>}
    {creating && <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setCreating(false) }}><form className="modal-card compact-modal" onSubmit={submit}><div className="modal-header"><div className="modal-badge">◎</div><div><h2>New CLI profile</h2><p>Create an isolated local account home.</p></div><button type="button" className="icon-button" onClick={() => setCreating(false)} aria-label="Close">×</button></div><label className="form-label">Profile name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Personal Claude" /></label><label className="form-label">CLI<select value={command} onChange={(event) => setCommand(event.target.value)}><option value="claude">Claude Code</option><option value="codex">Codex</option><option value="gemini">Gemini CLI</option><option value="*">Any CLI</option></select></label><div className="modal-note"><span>◉</span><p>The profile starts empty. Run the selected CLI and sign in with the account you want to use there.</p></div><div className="modal-footer"><button type="button" className="button button-outline" onClick={() => setCreating(false)}>Cancel</button><button className="button button-primary">Create profile</button></div></form></div>}
  </div>
}

function MemoryPage({ workspace, globalMemory, terminals, onSave, onPush }: {
  workspace: Workspace
  globalMemory: string
  terminals: BoardItem[]
  onSave: (kind: 'project' | 'global', value: string) => void
  onPush: (terminalId: string, kind: 'project' | 'global') => Promise<boolean>
}) {
  const [target, setTarget] = useState(terminals[0]?.id ?? '')
  useEffect(() => { if (!terminals.some((item) => item.id === target)) setTarget(terminals[0]?.id ?? '') }, [terminals, target])
  return <div className="secondary-page memory-page">
    <div className="page-intro"><div><span className="eyebrow">LOCAL CONTEXT</span><h1>Memory</h1><p>Keep reusable project and global notes here, then deliberately place them in a local console.</p></div><span className="local-only-pill"><i /> Stored locally</span></div>
    <div className="memory-grid"><section className="memory-card"><div className="panel-heading"><div><h2>Project memory</h2><p>Context for {workspace.name}</p></div><span className="activity-range">WORKSPACE</span></div><textarea value={workspace.projectMemory ?? ''} onChange={(event) => onSave('project', event.target.value)} placeholder="Decisions, conventions, project-specific context…"/><div className="memory-footer"><span>Saved with this workspace</span><button className="button button-outline" onClick={() => void onPush(target, 'project')} disabled={!target || !workspace.projectMemory?.trim()}>Push to console</button></div></section>
    <section className="memory-card"><div className="panel-heading"><div><h2>Global memory</h2><p>Context shared across your workspaces</p></div><span className="activity-range">ALL WORKSPACES</span></div><textarea value={globalMemory} onChange={(event) => onSave('global', event.target.value)} placeholder="Preferences and context useful in any project…"/><div className="memory-footer"><span>Saved in Megavibe local data</span><button className="button button-outline" onClick={() => void onPush(target, 'global')} disabled={!target || !globalMemory.trim()}>Push to console</button></div></section></div>
    <div className="memory-target"><label>Target console<select value={target} onChange={(event) => setTarget(event.target.value)}><option value="">No running console</option>{terminals.map((item) => <option key={item.id} value={item.id}>{item.data.title}</option>)}</select></label><small>Megavibe pastes this text without pressing Enter. Review it in the console before submitting.</small></div>
  </div>
}

function LoopsPage({ loops, terminals, statuses, onCreate, onUpdate, onPrepare, onRemove }: {
  loops: LoopRule[]
  terminals: BoardItem[]
  statuses: Record<string, RuntimeStatus>
  onCreate: () => void
  onUpdate: (id: string, update: Partial<LoopRule>) => void
  onPrepare: (loop: LoopRule) => Promise<void>
  onRemove: (id: string) => void
}) {
  const terminalName = (id: string) => terminals.find((node) => node.id === id)?.data.title ?? 'Removed console'
  return <div className="secondary-page loops-page"><div className="page-intro"><div><span className="eyebrow">LOCAL PROMPT ROUTINES</span><h1>Loops</h1><p>Schedule prompts for a console, or prepare one after it goes idle or prints matching output.</p></div><button className="button button-primary" onClick={onCreate} disabled={!terminals.length}>＋ New loop</button></div>
    <div className="feature-note"><span>◉</span><div><strong>Prepared prompts only</strong><p>Rules run while Megavibe stays open and the target console is running. Triggers queue a prompt for your review; Prepare pastes it without pressing Enter or approving CLI actions. Completion markers are reviewed before a loop retires.</p></div></div>
    {loops.length ? <div className="loop-list">{loops.map((loop) => <article className={`loop-card ${loop.pending ? 'loop-pending' : ''}`} key={loop.id}>
      <header><div><span className={`loop-state ${loop.enabled ? 'enabled' : loop.goalMet ? 'complete' : 'paused'}`} /> <strong>{loop.name}</strong></div><span className="activity-range">{loop.runs}/{loop.maxRuns} RUNS</span></header>
      <div className="loop-meta"><span>{loop.trigger === 'schedule' ? `Every ${loop.intervalMinutes} min` : loop.trigger === 'idle' ? `After ${loop.intervalMinutes} min idle` : `On output${loop.outputMatch ? ` containing “${loop.outputMatch}”` : ''}`}</span><span>{terminalName(loop.terminalId)} · {(statuses[loop.terminalId] ?? 'stopped').toUpperCase()}</span></div>
      <p className="loop-goal"><b>Goal:</b> {loop.goal}</p><pre>{loop.prompt}</pre>
      {loop.pending && <div className="loop-ready" role="status">Prompt is ready for review{loop.lastTriggeredAt ? ` · ${new Date(loop.lastTriggeredAt).toLocaleTimeString()}` : ''}</div>}
      {loop.completionCandidate && !loop.goalMet && <div className="loop-ready" role="status">Completion marker seen in new terminal output. Review the output; PTYs can also echo pasted input.</div>}
      <footer>
        <button className="text-button" onClick={() => onUpdate(loop.id, { enabled: !loop.enabled, goalMet: false, completionCandidate: false })} disabled={loop.goalMet || loop.runs >= loop.maxRuns}>{loop.enabled ? 'Pause' : 'Resume'}</button>
        <button className="text-button" onClick={() => onUpdate(loop.id, { goalMet: true, enabled: false, pending: false, completionCandidate: false })} disabled={loop.goalMet}>{loop.completionCandidate ? 'Confirm complete' : 'Mark goal complete'}</button>
        <button className="text-button" onClick={() => onRemove(loop.id)}>Remove</button><span />
        {loop.pending && <button className="button button-primary" onClick={() => onPrepare(loop)} disabled={statuses[loop.terminalId] !== 'running'}>Prepare prompt</button>}
      </footer>
    </article>)}</div> : <div className="empty-surface"><div className="empty-icon">↻</div><h2>No prompt loops yet</h2><p>Create a bounded rule for a console, with a clear goal and run limit.</p><button className="button button-primary" disabled={!terminals.length} onClick={onCreate}>＋ Create a loop</button></div>}
  </div>
}

function LoopDialog({ terminals, onClose, onSave }: {
  terminals: BoardItem[]
  onClose: () => void
  onSave: (rule: Pick<LoopRule, 'name' | 'terminalId' | 'trigger' | 'intervalMinutes' | 'outputMatch' | 'prompt' | 'goal' | 'maxRuns'>) => void
}) {
  useEscapeKey(onClose)
  useEscapeKey(onClose)
  const [name, setName] = useState('Review loop')
  const [terminalId, setTerminalId] = useState(terminals[0]?.id ?? '')
  const [trigger, setTrigger] = useState<LoopRule['trigger']>('schedule')
  const [intervalMinutes, setIntervalMinutes] = useState(15)
  const [outputMatch, setOutputMatch] = useState('')
  const [prompt, setPrompt] = useState('Review the current state, summarize what changed, and identify the next step.')
  const [goal, setGoal] = useState('Stop when the planned task is complete.')
  const [maxRuns, setMaxRuns] = useState(4)
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><form className="modal-card loop-dialog" onSubmit={(event) => { event.preventDefault(); if (terminalId && prompt.trim() && goal.trim()) onSave({ name: name.trim() || 'Prompt loop', terminalId, trigger, intervalMinutes: Math.max(1, Math.min(1440, intervalMinutes)), outputMatch: outputMatch.trim() || undefined, prompt: prompt.trim(), goal: goal.trim(), maxRuns: Math.max(1, Math.min(100, maxRuns)) }) }}><div className="modal-header"><div className="modal-badge team-badge">↻</div><div><h2>New prompt loop</h2><p>Set a trigger, review prompt, goal, and stop limit.</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close">×</button></div><label className="form-label">Loop name<input autoFocus value={name} onChange={(event) => setName(event.target.value)} /></label><label className="form-label">Console<select value={terminalId} onChange={(event) => setTerminalId(event.target.value)}>{terminals.map((node) => <option key={node.id} value={node.id}>{node.data.title} · {node.data.command ?? 'bash'}</option>)}</select></label><div className="loop-form-row"><label className="form-label">Trigger<select value={trigger} onChange={(event) => setTrigger(event.target.value as LoopRule['trigger'])}><option value="schedule">Schedule</option><option value="idle">When idle</option><option value="output">On output</option></select></label><label className="form-label">Interval (minutes)<input type="number" min="1" max="1440" value={intervalMinutes} onChange={(event) => setIntervalMinutes(Number(event.target.value) || 1)} /></label></div>{trigger === 'output' && <label className="form-label">Output contains (optional)<input value={outputMatch} onChange={(event) => setOutputMatch(event.target.value)} placeholder="permission, complete, error…" /></label>}<label className="form-label">Prompt<textarea className="args-field" value={prompt} onChange={(event) => setPrompt(event.target.value)} /></label><label className="form-label">Goal<input value={goal} onChange={(event) => setGoal(event.target.value)} placeholder="What will make this loop complete?" /></label><label className="form-label">Maximum prompt count<input type="number" min="1" max="100" value={maxRuns} onChange={(event) => setMaxRuns(Number(event.target.value) || 1)} /></label><div className="modal-note"><span>◉</span><p>Loops are local and bounded. They queue prompts and never auto-submit them.</p></div><div className="modal-footer"><button type="button" className="button button-outline" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={!terminals.length || !prompt.trim() || !goal.trim()}>Create loop</button></div></form></div>
}

function HandoffDialog({ sourceId, workspace, statuses, output, onClose, onSend }: {
  sourceId: string
  workspace: Workspace
  statuses: Record<string, RuntimeStatus>
  output: string
  onClose: () => void
  onSend: (id: string, text: string) => Promise<boolean>
}) {
  const source = workspace.nodes.find((node) => node.id === sourceId)
  const targets = workspace.nodes.filter((node) => node.data.kind === 'terminal' && node.id !== sourceId && statuses[node.id] === 'running')
  const [targetId, setTargetId] = useState(targets[0]?.id ?? '')
  useEscapeKey(onClose)
  const [summary, setSummary] = useState(() => summarizeTerminalOutput(output))
  const [sending, setSending] = useState(false)
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!targetId || !summary.trim() || sending) return
    setSending(true)
    try {
      if (await onSend(targetId, `\n\nHandoff from ${source?.data.title ?? 'console'}:\n${summary.trim()}\n`)) onClose()
    } finally {
      setSending(false)
    }
  }
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}><form className="modal-card compact-modal" onSubmit={(event) => { void submit(event) }}><div className="modal-header"><div className="modal-badge team-badge">↗</div><div><h2>Prepare handoff</h2><p>Review a local summary draft for another running console.</p></div><button type="button" className="icon-button" onClick={onClose} aria-label="Close">×</button></div><label className="form-label">From<input value={source?.data.title ?? ''} readOnly /></label><label className="form-label">To<select value={targetId} onChange={(event) => setTargetId(event.target.value)}>{targets.map((node) => <option key={node.id} value={node.id}>{node.data.title}</option>)}</select></label><label className="form-label">Handoff summary<textarea className="args-field" value={summary} onChange={(event) => setSummary(event.target.value)} placeholder="What has been done, what remains, relevant files, and the next step…" /></label><div className="modal-note"><span>◉</span><p>The draft uses recent local terminal output, masks common tokens, and stays editable. It is pasted without pressing Enter.</p></div><div className="modal-footer"><button type="button" className="button button-outline" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={!targetId || !summary.trim() || sending}>{sending ? 'Preparing…' : 'Prepare handoff'}</button></div></form></div>
}

function AppRoot() {
  return <ReactFlowProvider><App /></ReactFlowProvider>
}

export default AppRoot
