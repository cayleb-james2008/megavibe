import { createContext, useContext } from 'react'
import type { BoardItemData } from './model'

export type RuntimeStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'error'

export type BoardRuntime = {
  workspacePath: string | null
  statuses: Record<string, RuntimeStatus | undefined>
  messages: Record<string, string | undefined>
  startTerminal: (id: string, resume?: boolean) => void
  stopTerminal: (id: string) => void
  setStatus: (id: string, status: RuntimeStatus) => void
  removeNode: (id: string) => void
  editTerminal: (id: string) => void
  updateNode: (id: string, update: (data: BoardItemData) => BoardItemData) => void
  addTerminal: (command: string, title: string, team?: string) => void
  sendText: (id: string, text: string) => Promise<boolean>
  prepareHandoff: (id: string) => void
  getOutput: (id: string) => string
  openGit: () => void
}

const RuntimeContext = createContext<BoardRuntime | null>(null)

export const BoardRuntimeProvider = RuntimeContext.Provider

export function useBoardRuntime() {
  const value = useContext(RuntimeContext)
  if (!value) throw new Error('Board node requires the runtime context.')
  return value
}
