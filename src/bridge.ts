import { Channel, invoke, isTauri } from '@tauri-apps/api/core'
import type { AppState } from './model'

export type OutputEvent = { kind: 'output' | 'exit'; data: string; runToken: number }

export const inDesktopApp = isTauri()

export async function loadState() {
  if (inDesktopApp) return invoke<AppState | null>('load_state')
  const stored = localStorage.getItem('megavibe-workspace')
  return stored ? (JSON.parse(stored) as AppState) : null
}

export async function saveState(state: AppState) {
  if (inDesktopApp) return invoke<void>('save_state', { state })
  localStorage.setItem('megavibe-workspace', JSON.stringify(state))
}

export async function chooseFolder() {
  if (inDesktopApp) return invoke<string | null>('choose_project_folder')
  return null
}

export function outputChannel() {
  return new Channel<OutputEvent>()
}

export { invoke }
