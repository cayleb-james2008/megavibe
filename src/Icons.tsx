import type { ReactNode } from 'react'
import type { ItemKind } from './model'

export type IconName =
  | 'board' | 'voice' | 'teams' | 'studios' | 'git' | 'usage' | 'memory' | 'profiles' | 'loops' | 'settings'
  | 'terminal' | 'note' | 'checklist' | 'kanban' | 'text' | 'calendar' | 'drawing' | 'image' | 'code' | 'diagram' | 'preview'
  | 'check' | 'handoff'
  | 'plus' | 'minus' | 'close' | 'chevron-down' | 'arrow-left' | 'arrow-right' | 'refresh' | 'stop' | 'fit' | 'info' | 'external'

const shapes: Record<IconName, ReactNode> = {
  board: <><rect x="3.5" y="3.5" width="17" height="17" rx="3" /><path d="M9.25 3.5v17M3.5 9.25h17" /></>,
  voice: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v3M8.5 21h7" /></>,
  teams: <><circle cx="9" cy="8" r="3.2" /><path d="M3.5 19.5c0-3.1 2.5-5 5.5-5s5.5 1.9 5.5 5" /><circle cx="17" cy="9.5" r="2.3" /><path d="M16.2 14.7c2.6.1 4.3 1.7 4.3 4.3" /></>,
  studios: <><path d="M12 3.5l8 4.25-8 4.25-8-4.25z" /><path d="M4 12l8 4.25 8-4.25" /><path d="M4 16.4l8 4.25 8-4.25" /></>,
  git: <><circle cx="6" cy="5.5" r="2.3" /><circle cx="6" cy="18.5" r="2.3" /><circle cx="17.5" cy="7.5" r="2.3" /><path d="M6 7.8v8.4M17.5 9.8c0 4-3.4 6.4-8.1 7.2" /></>,
  usage: <path d="M3 12.5h3.6l2.4-6.5 4.2 12.5 2.6-8 1.7 2h3.5" />,
  memory: <path d="M7 3.5h10a1 1 0 0 1 1 1v16.2l-6-4.1-6 4.1V4.5a1 1 0 0 1 1-1z" />,
  profiles: <><circle cx="12" cy="12" r="8.6" /><circle cx="12" cy="10" r="3" /><path d="M6.6 19.2a6.2 6.2 0 0 1 10.8 0" /></>,
  loops: <><path d="M3.5 12a8.5 8.5 0 0 1 14.6-6" /><path d="M18.6 2.2l.7 4-4 .8" /><path d="M20.5 12a8.5 8.5 0 0 1-14.6 6" /><path d="M5.4 21.8l-.7-4 4-.8" /></>,
  settings: <><path d="M4 7h6M14 7h6M4 12h10M18 12h2M4 17h3M11 17h9" /><circle cx="12" cy="7" r="2" /><circle cx="16" cy="12" r="2" /><circle cx="9" cy="17" r="2" /></>,
  terminal: <><path d="M5 6.5l4.5 5.5L5 17.5" /><path d="M11.5 17.5h7.5" /></>,
  note: <><rect x="4.5" y="3.5" width="15" height="17" rx="2.5" /><path d="M8.5 8.5h7M8.5 12h7M8.5 15.5h4.5" /></>,
  checklist: <><rect x="3.8" y="3.8" width="16.4" height="16.4" rx="3.2" /><path d="M8 12.4l2.9 2.9 5.3-6.2" /></>,
  kanban: <><rect x="3.5" y="4" width="4.6" height="16" rx="1.6" /><rect x="9.7" y="4" width="4.6" height="10.5" rx="1.6" /><rect x="15.9" y="4" width="4.6" height="13.5" rx="1.6" /></>,
  text: <><path d="M5 7.5V5h14v2.5" /><path d="M12 5v14M9 19h6" /></>,
  calendar: <><rect x="3.5" y="5.5" width="17" height="15" rx="2.5" /><path d="M3.5 10.5h17M8 3v4M16 3v4" /></>,
  drawing: <><path d="M15.2 3.8l5 5L9 20H4v-5z" /><path d="M12.8 6.2l5 5" /></>,
  image: <><rect x="3.5" y="4.5" width="17" height="15" rx="2.5" /><circle cx="9" cy="9.8" r="1.7" /><path d="M5.5 16.8l4.2-4.2 2.6 2.6 3-2.5 3.2 3.4" /></>,
  code: <><path d="M8.3 8L4.3 12l4 4" /><path d="M15.7 8l4 4-4 4" /><path d="M13.4 6.2l-2.8 11.6" /></>,
  diagram: <><circle cx="6" cy="6" r="2.3" /><circle cx="18" cy="8" r="2.3" /><circle cx="11" cy="18.2" r="2.3" /><path d="M7.6 7.8l3.1 8.3M16.3 9.7l-3.6 7M8.1 6.6l7.6 1.1" /></>,
  check: <path d="M5 12.5l4.6 4.6L19 7.5" />,
  handoff: <><path d="M3.5 12.5h11" /><path d="M12 8.5l4 4-4 4" /><path d="M19.5 5.5v13" /></>,
  preview: <><circle cx="12" cy="12" r="8.6" /><path d="M12 3.4c-3.2 3.7-3.2 13.5 0 17.2M12 3.4c3.2 3.7 3.2 13.5 0 17.2" /><path d="M3.6 12h16.8" /></>,
  plus: <><path d="M12 5.2v13.6M5.2 12h13.6" /></>,
  minus: <path d="M5.2 12h13.6" />,
  close: <><path d="M6.6 6.6l10.8 10.8M17.4 6.6L6.6 17.4" /></>,
  'chevron-down': <path d="M6.2 9.4l5.8 5.6 5.8-5.6" />,
  'arrow-left': <><path d="M19.2 12H5" /><path d="M10.6 6.2L4.8 12l5.8 5.8" /></>,
  'arrow-right': <><path d="M4.8 12h14.2" /><path d="M13.4 6.2l5.8 5.8-5.8 5.8" /></>,
  refresh: <><path d="M20.4 12a8.4 8.4 0 1 1-2.5-6" /><path d="M18.4 2.6v3.9h-3.9" /></>,
  stop: <rect x="7" y="7" width="10" height="10" rx="1.8" />,
  fit: <><path d="M4 9V5.6A1.6 1.6 0 0 1 5.6 4H9M15 4h3.4A1.6 1.6 0 0 1 20 5.6V9M20 15v3.4a1.6 1.6 0 0 1-1.6 1.6H15M9 20H5.6A1.6 1.6 0 0 1 4 18.4V15" /></>,
  info: <><circle cx="12" cy="12" r="8.6" /><path d="M12 11.2v5.4M12 7.9h.01" /></>,
  external: <><path d="M9.5 5H19v9.5" /><path d="M19 5L10.2 13.8" /><path d="M15 19H5V9" /></>,
}

export function Icon({ name, size = 16, className }: { name: IconName; size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      {shapes[name]}
    </svg>
  )
}

export const kindIcon: Record<ItemKind | 'git', IconName> = {
  terminal: 'terminal',
  note: 'note',
  text: 'text',
  checklist: 'checklist',
  kanban: 'kanban',
  calendar: 'calendar',
  drawing: 'drawing',
  image: 'image',
  code: 'code',
  diagram: 'diagram',
  preview: 'preview',
  git: 'git',
}
