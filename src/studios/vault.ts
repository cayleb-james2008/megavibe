import type { VaultDocument } from '../model'

const metadataPrefix = '<!-- megavibe-vault '

export type VaultFile = { relativePath: string; title: string; content: string }
export type VaultListing = { files: VaultFile[]; truncated: boolean }
export type VaultEntry = VaultDocument & { relativePath: string }
export type VaultLink = { from: string; to: string }
export type GraphPoint = { x: number; y: number }

function hash(value: string) {
  let result = 2166136261
  for (const character of value) result = Math.imul(result ^ character.charCodeAt(0), 16777619)
  return (result >>> 0).toString(36)
}

export function parseVaultFile(file: VaultFile): VaultEntry {
  const firstLine = file.content.split(/\r?\n/, 1)[0]
  if (firstLine.startsWith(metadataPrefix) && firstLine.endsWith('-->')) {
    try {
      const metadata = JSON.parse(firstLine.slice(metadataPrefix.length, -3).trim()) as { id?: string; title?: string }
      return {
        id: metadata.id || `vault-${hash(file.relativePath)}`,
        title: metadata.title || file.title,
        content: file.content.slice(firstLine.length).replace(/^\r?\n/, ''),
        relativePath: file.relativePath,
      }
    } catch { /* Keep malformed user-authored metadata visible as ordinary Markdown. */ }
  }
  return { id: `vault-${hash(file.relativePath)}`, title: file.title, content: file.content, relativePath: file.relativePath }
}

export function serializeVaultEntry(entry: VaultEntry) {
  return `${metadataPrefix}${JSON.stringify({ id: entry.id, title: entry.title })} -->\n${entry.content}`
}

export function vaultPathForTitle(title: string, id: string, existing: Set<string>) {
  const slug = title.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'untitled'
  let candidate = `${slug}.md`
  if (existing.has(candidate.toLowerCase())) candidate = `${slug}-${id.slice(-6)}.md`
  let suffix = 2
  while (existing.has(candidate.toLowerCase())) candidate = `${slug}-${id.slice(-6)}-${suffix++}.md`
  return candidate
}

export function migrateLegacyVault(documents: VaultDocument[], files: VaultFile[]) {
  const parsed = files.map(parseVaultFile)
  const existingIds = new Set(parsed.map((entry) => entry.id))
  const paths = new Set(files.map((file) => file.relativePath.toLowerCase()))
  const imports: VaultEntry[] = []
  for (const document of documents) {
    if (existingIds.has(document.id)) continue
    const relativePath = vaultPathForTitle(document.title, document.id, paths)
    paths.add(relativePath.toLowerCase())
    imports.push({ ...document, relativePath })
  }
  return { entries: [...parsed, ...imports], imports }
}

function normalizedTarget(value: string) {
  return value.trim().replace(/\\/g, '/').replace(/\.md$/i, '').toLocaleLowerCase()
}

export function linkVaultEntries(entries: VaultEntry[]): VaultLink[] {
  const byTarget = new Map<string, string>()
  for (const entry of entries) {
    byTarget.set(normalizedTarget(entry.title), entry.id)
    byTarget.set(normalizedTarget(entry.relativePath), entry.id)
    byTarget.set(normalizedTarget(entry.relativePath.split('/').pop() ?? ''), entry.id)
  }
  const links = new Set<string>()
  for (const entry of entries) {
    const targets = [...entry.content.matchAll(/\[\[([^\]]+)\]\]/g)].map((match) => match[1])
    for (const target of targets) {
      const id = byTarget.get(normalizedTarget(target.split('|')[0]))
      if (id && id !== entry.id) links.add(`${entry.id}\u0000${id}`)
    }
    for (const match of entry.content.matchAll(/\[[^\]]*\]\(([^)]+\.md(?:#[^)]*)?)\)/gi)) {
      const target = match[1].split('#')[0]
      const id = byTarget.get(normalizedTarget(target))
      if (id && id !== entry.id) links.add(`${entry.id}\u0000${id}`)
    }
  }
  return [...links].map((link) => {
    const [from, to] = link.split('\u0000')
    return { from, to }
  })
}

export function layoutVaultGraph(entries: VaultEntry[], links: VaultLink[], width = 820, height = 430) {
  const count = entries.length
  const points = new Map<string, GraphPoint>()
  entries.forEach((entry, index) => {
    const angle = index * 2.399963229728653
    const radius = 28 + Math.sqrt(index + 1) * Math.min(width, height) * 0.095
    points.set(entry.id, { x: width / 2 + Math.cos(angle) * radius, y: height / 2 + Math.sin(angle) * radius })
  })
  for (let iteration = 0; iteration < 75; iteration += 1) {
    const force = new Map(entries.map((entry) => [entry.id, { x: 0, y: 0 }]))
    for (let left = 0; left < count; left += 1) {
      const a = points.get(entries[left].id)!
      for (let right = left + 1; right < count; right += 1) {
        const b = points.get(entries[right].id)!
        let dx = a.x - b.x
        let dy = a.y - b.y
        const distance2 = dx * dx + dy * dy + 2
        const distance = Math.sqrt(distance2)
        const repulsion = Math.min(90, 2100 / distance2)
        dx = dx / distance * repulsion
        dy = dy / distance * repulsion
        force.get(entries[left].id)!.x += dx
        force.get(entries[left].id)!.y += dy
        force.get(entries[right].id)!.x -= dx
        force.get(entries[right].id)!.y -= dy
      }
    }
    for (let index = 0; index < links.length; index += 1) {
      const link = links[index]
      const source = points.get(link.from)
      const target = points.get(link.to)
      if (!source || !target) continue
      const dx = target.x - source.x
      const dy = target.y - source.y
      const distance = Math.hypot(dx, dy) || 1
      const attraction = (distance - 105) * 0.01
      force.get(link.from)!.x += dx / distance * attraction
      force.get(link.from)!.y += dy / distance * attraction
      force.get(link.to)!.x -= dx / distance * attraction
      force.get(link.to)!.y -= dy / distance * attraction
    }
    const cooling = 0.75 * (1 - iteration / 95)
    for (const entry of entries) {
      const point = points.get(entry.id)!
      const delta = force.get(entry.id)!
      point.x = Math.max(48, Math.min(width - 48, point.x + Math.max(-16, Math.min(16, delta.x * cooling))))
      point.y = Math.max(52, Math.min(height - 42, point.y + Math.max(-16, Math.min(16, delta.y * cooling))))
    }
  }
  return points
}
