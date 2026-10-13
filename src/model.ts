import type { Edge, Node, Viewport } from '@xyflow/react'

export type ItemKind = 'terminal' | 'note' | 'checklist' | 'preview' | 'kanban' | 'text' | 'calendar' | 'drawing' | 'code' | 'diagram' | 'image' | 'git'

export type ChecklistItem = {
  id: string
  text: string
  done: boolean
}

export type KanbanItem = {
  id: string
  text: string
  status: 'todo' | 'doing' | 'done'
}

export type CalendarItem = {
  id: string
  date: string
  text: string
}

export type VaultDocument = {
  id: string
  title: string
  content: string
}

export type CliProfile = {
  id: string
  name: string
  command: string
}

export type LoopRule = {
  id: string
  name: string
  workspaceId: string
  terminalId: string
  trigger: 'schedule' | 'idle' | 'output'
  intervalMinutes: number
  outputMatch?: string
  prompt: string
  goal: string
  maxRuns: number
  runs: number
  createdAt: number
  lastTriggeredAt?: number
  lastOutputSequence?: number
  completionCandidate?: boolean
  enabled: boolean
  goalMet: boolean
  pending: boolean
}

export type BoardItemData = {
  kind: ItemKind
  title: string
  command?: string
  args?: string[]
  resumeArgs?: string[]
  sessionId?: string
  scrollback?: string
  resumeOnLaunch?: boolean
  cwd?: string
  content?: string
  items?: ChecklistItem[]
  tasks?: KanbanItem[]
  events?: CalendarItem[]
  strokes?: Array<{ color: string; points: Array<{ x: number; y: number }> }>
  url?: string
  team?: string
  profileId?: string
  missionState?: 'working' | 'resting' | 'needs-you'
  filePath?: string
  diagramSvg?: string
  imageData?: string
}

export type BoardItem = Node<BoardItemData, 'boardItem'>

export type Workspace = {
  id: string
  name: string
  path: string | null
  nodes: BoardItem[]
  edges: Edge[]
  viewport?: Viewport
  projectMemory?: string
  vault?: VaultDocument[]
}

export type TeamMember = {
  id: string
  name: string
  cli: 'Claude Code' | 'Codex' | 'Gemini CLI' | 'Shell'
}

export type Team = {
  id: string
  name: string
  purpose: string
  members: TeamMember[]
}

export type AppState = {
  version: 2
  activeWorkspaceId: string
  workspaces: Workspace[]
  teams: Team[]
  profiles: CliProfile[]
  globalMemory: string
  loops: LoopRule[]
  approvalMode?: 'default' | 'edits' | 'all'
}

export const cliCommands: Record<TeamMember['cli'], string> = {
  'Claude Code': 'claude',
  Codex: 'codex',
  'Gemini CLI': 'gemini',
  Shell: 'bash',
}

export function getResumeArgs(command: string, configured?: string[], sessionId?: string): string[] | null {
  const name = command.split('/').pop()?.toLowerCase()
  if (configured?.length) return configured
  if (name === 'claude') return sessionId ? ['--resume', sessionId] : ['--continue']
  if (name === 'codex') return sessionId ? ['resume', sessionId] : ['resume']
  if (name === 'gemini') return ['--resume', sessionId ?? 'latest']
  return null
}

export function getSessionStartArgs(command: string, sessionId?: string): string[] {
  const name = command.split('/').pop()?.toLowerCase()
  if (!sessionId) return []
  if (name === 'claude' || name === 'gemini') return ['--session-id', sessionId]
  return []
}

export function supportsSessionIdentity(command: string) {
  const name = command.split('/').pop()?.toLowerCase()
  return name === 'claude' || name === 'gemini'
}

export function createCliSessionId(command: string): string | undefined {
  const name = command.split('/').pop()?.toLowerCase()
  return name === 'claude' || name === 'gemini' ? crypto.randomUUID() : undefined
}

export function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`
}

export function createWorkspace(name = 'My workspace', path: string | null = null): Workspace {
  const id = makeId('workspace')
  return {
    id,
    name,
    path,
    nodes: [
      {
        id: makeId('terminal'),
        type: 'boardItem',
        position: { x: 260, y: 180 },
        style: { width: 500 },
        data: { kind: 'terminal', title: 'Shell', command: 'bash', args: [] },
      },
      {
        id: makeId('note'),
        type: 'boardItem',
        position: { x: 800, y: 155 },
        style: { width: 300 },
        data: {
          kind: 'note',
          title: 'Project notes',
          content: 'Keep the brief, decisions, and next steps close to your work.',
        },
      },
    ],
    edges: [],
    viewport: { x: 0, y: 0, zoom: 1 },
    projectMemory: '',
    vault: [],
  }
}

export function createInitialState(): AppState {
  const workspace = createWorkspace('Getting started')
  return {
    version: 2,
    activeWorkspaceId: workspace.id,
    workspaces: [workspace],
    teams: [
      {
        id: makeId('team'),
        name: 'Build crew',
        purpose: 'A small local team for focused project work.',
        members: [
          { id: makeId('member'), name: 'Planner', cli: 'Claude Code' },
          { id: makeId('member'), name: 'Builder', cli: 'Codex' },
          { id: makeId('member'), name: 'Reviewer', cli: 'Shell' },
        ],
      },
    ],
    profiles: [],
    globalMemory: '',
    loops: [],
    approvalMode: 'default',
  }
}

export function migrateAppState(value: unknown): AppState {
  if (!value || typeof value !== 'object') return createInitialState()
  const raw = value as Partial<AppState>
  const fallback = createInitialState()
  const migratedWorkspaces = Array.isArray(raw.workspaces) ? raw.workspaces.map((workspace) => ({
    ...workspace,
    projectMemory: workspace.projectMemory ?? '',
    vault: Array.isArray(workspace.vault) ? workspace.vault : [],
  })) : fallback.workspaces
  const workspaces = migratedWorkspaces.length ? migratedWorkspaces : fallback.workspaces
  return {
    ...fallback,
    ...raw,
    version: 2,
    workspaces,
    activeWorkspaceId: workspaces.some((item) => item.id === raw.activeWorkspaceId) ? raw.activeWorkspaceId! : workspaces[0].id,
    teams: Array.isArray(raw.teams) ? raw.teams : fallback.teams,
    profiles: Array.isArray(raw.profiles) ? raw.profiles : [],
    globalMemory: typeof raw.globalMemory === 'string' ? raw.globalMemory : '',
    loops: Array.isArray(raw.loops) ? raw.loops.map((loop) => ({
      ...loop,
      workspaceId: loop.workspaceId ?? workspaces.find((item) => item.nodes.some((node) => node.id === loop.terminalId))?.id ?? workspaces[0].id,
    })) : [],
    approvalMode: raw.approvalMode === 'edits' || raw.approvalMode === 'all' ? raw.approvalMode : 'default',
  }
}

export function getApprovalArgs(command: string, mode: AppState['approvalMode'], configuredArgs: string[] = []) {
  if (!mode || mode === 'default') return []
  const name = command.split('/').pop()?.toLowerCase()
  const permissionFlags = new Set([
    '--permission-mode', '--dangerously-skip-permissions',
    '--ask-for-approval', '-a', '--sandbox', '-s', '--dangerously-bypass-approvals-and-sandbox', '--full-auto',
    '--approval-mode', '--yolo', '-y',
  ])
  if (configuredArgs.some((arg) => permissionFlags.has(arg.split('=', 1)[0]))) return []
  if (name === 'claude') return mode === 'edits' ? ['--permission-mode', 'acceptEdits'] : ['--dangerously-skip-permissions']
  if (name === 'codex') return mode === 'edits' ? ['--ask-for-approval', 'never', '--sandbox', 'workspace-write'] : ['--dangerously-bypass-approvals-and-sandbox']
  if (name === 'gemini') return ['--approval-mode', mode === 'edits' ? 'auto_edit' : 'yolo']
  return []
}
