import { invoke } from '../bridge'
import type { Workspace } from '../model'

export type ProjectFile = { path: string; directory: boolean }
export type RepoFigure = { svg: string; files: number; modules: number; relationships: number }

const sourceExtensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.rs', '.go', '.java', '.kt', '.swift', '.rb', '.php', '.vue', '.svelte'])
const manifests = ['package.json', 'Cargo.toml', 'pyproject.toml', 'requirements.txt', 'go.mod', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Gemfile', 'composer.json']

function extension(path: string) {
  const name = path.split('/').pop() ?? ''
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(dot).toLowerCase() : ''
}

function xml(text: string) {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;')
}

function projectModule(path: string) {
  const parts = path.split('/')
  return parts.length > 2 ? parts.slice(0, 2).join('/') : parts.length > 1 ? parts[0] : '(root)'
}

function localImportTargets(path: string, source: string, available: Set<string>) {
  const found = new Set<string>()
  const expressions = [
    /(?:from\s*|import\s*\(|require\s*\()\s*["'](\.{1,2}\/[^"']+)["']/g,
    /(?:^|\n)\s*mod\s+([A-Za-z_][\w]*)\s*;/g,
  ]
  for (const expression of expressions) {
    for (const match of source.matchAll(expression)) {
      const specifier = match[1]
      let base = ''
      if (specifier.startsWith('.')) {
        const parts = path.split('/')
        parts.pop()
        for (const segment of specifier.split('/')) {
          if (segment === '.') continue
          if (segment === '..') parts.pop()
          else parts.push(segment)
        }
        base = parts.join('/')
      } else if (expression === expressions[1]) {
        base = path.includes('/') ? `${path.slice(0, path.lastIndexOf('/') + 1)}${specifier}` : specifier
      }
      if (!base) continue
      const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.rs', '.go'].map((suffix) => `${base}${suffix}`), ...['index.ts', 'index.tsx', 'index.js', '__init__.py', 'mod.rs'].map((name) => `${base}/${name}`)]
      const resolved = candidates.find((candidate) => candidate !== path && available.has(candidate))
      if (resolved) found.add(resolved)
    }
  }
  for (const match of source.matchAll(/^\s*from\s+(\.+[\w.]*)\s+import\s+/gm)) {
    const specifier = match[1]
    const parent = path.split('/')
    parent.pop()
    let dots = 0
    while (specifier[dots] === '.') dots += 1
    for (let step = 1; step < dots; step += 1) parent.pop()
    const moduleName = specifier.slice(dots).replace(/\./g, '/')
    const base = [...parent, ...moduleName.split('/').filter(Boolean)].join('/')
    const resolved = [base, `${base}.py`, `${base}/__init__.py`].find((candidate) => candidate && available.has(candidate))
    if (resolved) found.add(resolved)
  }
  for (const match of source.matchAll(/^\s*import\s+([\w.]+)\s*(?:#.*)?$/gm)) {
    const base = match[1].replace(/\./g, '/')
    const resolved = [base, `${base}.py`, `${base}/__init__.py`].find((candidate) => available.has(candidate))
    if (resolved) found.add(resolved)
  }
  for (const match of source.matchAll(/^\s*use\s+(?:crate::)?([\w:]+)/gm)) {
    const base = `src/${match[1].split('::')[0]}`
    const resolved = [`${base}.rs`, `${base}/mod.rs`].find((candidate) => available.has(candidate))
    if (resolved) found.add(resolved)
  }
  return [...found]
}

function layoutModules(names: string[], edges: Array<{ from: string; to: string }>) {
  const positions = new Map(names.map((name, index) => {
    const angle = (index / Math.max(1, names.length)) * Math.PI * 2 - Math.PI / 2
    const radius = Math.max(180, Math.min(430, 95 + names.length * 5))
    return [name, { x: Math.cos(angle) * radius, y: Math.sin(angle) * radius }]
  }))
  const degree = new Map(names.map((name) => [name, 0]))
  for (const edge of edges) {
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1)
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1)
  }
  for (let iteration = 0; iteration < 95; iteration += 1) {
    const forces = new Map(names.map((name) => [name, { x: 0, y: 0 }]))
    for (let left = 0; left < names.length; left += 1) {
      const a = positions.get(names[left])!
      for (let right = left + 1; right < names.length; right += 1) {
        const b = positions.get(names[right])!
        let dx = a.x - b.x
        let dy = a.y - b.y
        const distanceSquared = dx * dx + dy * dy + 0.1
        const distance = Math.sqrt(distanceSquared)
        const force = Math.min(120, 4600 / distanceSquared)
        dx = (dx / distance) * force
        dy = (dy / distance) * force
        forces.get(names[left])!.x += dx
        forces.get(names[left])!.y += dy
        forces.get(names[right])!.x -= dx
        forces.get(names[right])!.y -= dy
      }
    }
    for (const edge of edges) {
      const source = positions.get(edge.from)!
      const target = positions.get(edge.to)!
      const dx = target.x - source.x
      const dy = target.y - source.y
      const distance = Math.hypot(dx, dy) || 1
      const force = (distance - 185) * 0.012
      forces.get(edge.from)!.x += (dx / distance) * force
      forces.get(edge.from)!.y += (dy / distance) * force
      forces.get(edge.to)!.x -= (dx / distance) * force
      forces.get(edge.to)!.y -= (dy / distance) * force
    }
    const cooling = 0.72 * (1 - iteration / 120)
    for (const name of names) {
      const point = positions.get(name)!
      const force = forces.get(name)!
      point.x += Math.max(-18, Math.min(18, force.x * cooling))
      point.y += Math.max(-18, Math.min(18, force.y * cooling))
    }
  }
  return { positions, degree }
}

export async function generateProjectBrief(workspace: Workspace, onProgress: (message: string) => void) {
  const entries = workspace.path ? await invoke<ProjectFile[]>('list_project_files', { path: workspace.path }) : []
  const files = entries.filter((entry) => !entry.directory).map((entry) => entry.path)
  const readPaths = [...new Set(files.filter((path) => manifests.includes(path.split('/').pop() ?? '') || /^readme(?:\.[^/]*)?$/i.test(path.split('/').pop() ?? '')).sort((left, right) => Number(left.includes('/')) - Number(right.includes('/')) || left.localeCompare(right)).slice(0, 12))]
  const fileContents = new Map<string, string>()
  onProgress(`Reading ${readPaths.length} project manifests and overview files locally…`)
  await Promise.all(readPaths.map(async (relativePath) => {
    try {
      const content = await invoke<string>('read_project_file', { path: workspace.path, relativePath })
      fileContents.set(relativePath, content)
    } catch { /* Large, non-text, or protected files are omitted from the local report. */ }
  }))
  const readmeEntry = readPaths.find((path) => /^readme(?:\.[^/]*)?$/i.test(path.split('/').pop() ?? ''))
  const readme = readmeEntry ? fileContents.get(readmeEntry) : undefined
  const overview = readme?.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).filter((line) => !line.startsWith('#')).slice(0, 8).join('\n')
  const packageJson = [...fileContents.entries()].find(([path]) => path.split('/').pop() === 'package.json')?.[1]
  let packageDetails = ''
  if (packageJson) {
    try {
      const pkg = JSON.parse(packageJson) as { name?: string; version?: string; description?: string; scripts?: Record<string, string>; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
      const scripts = Object.entries(pkg.scripts ?? {}).map(([name, command]) => `- \`${name}\`: \`${command}\``).join('\n')
      const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies }).sort()
      packageDetails = [pkg.name && `- Package: \`${pkg.name}\`${pkg.version ? ` (${pkg.version})` : ''}`, pkg.description && `- Description: ${pkg.description}`, scripts && `### Available scripts\n\n${scripts}`, deps.length && `### Main dependencies\n\n${deps.slice(0, 30).map((dependency) => `- ${dependency}`).join('\n')}${deps.length > 30 ? `\n- …and ${deps.length - 30} more` : ''}`].filter(Boolean).join('\n\n')
    } catch { packageDetails = 'The package manifest is present but is not valid JSON.' }
  }
  const otherManifestDetails = readPaths.filter((path) => manifests.includes(path.split('/').pop() ?? '') && path.split('/').pop() !== 'package.json').map((path) => {
    const content = fileContents.get(path)
    if (!content) return ''
    const excerpt = content.split(/\r?\n/).slice(0, 42).map((line) => line.length > 220 ? `${line.slice(0, 217)}…` : line).join('\n')
    const language = extension(path).slice(1)
    return `### ${path}\n\n\`\`\`${language}\n${excerpt}\n\`\`\``
  }).filter(Boolean).join('\n\n')
  const directoryCounts = new Map<string, number>()
  for (const path of files) directoryCounts.set(projectModule(path), (directoryCounts.get(projectModule(path)) ?? 0) + 1)
  const types = new Map<string, number>()
  for (const path of files) types.set(extension(path) || '(no extension)', (types.get(extension(path) || '(no extension)') ?? 0) + 1)
  const boardNotes = workspace.nodes.filter((node) => ['note', 'text', 'checklist'].includes(node.data.kind))
  const notes = boardNotes.map((node) => `### ${node.data.title}\n\n${node.data.kind === 'checklist' ? (node.data.items ?? []).map((item) => `- [${item.done ? 'x' : ' '}] ${item.text}`).join('\n') : node.data.content ?? ''}`).join('\n\n')
  const tree = [...directoryCounts.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([directory, count]) => `- \`${directory}/\` — ${count} file${count === 1 ? '' : 's'}`).join('\n')
  const typeSummary = [...types.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([type, count]) => `- ${type}: ${count}`).join('\n')
  const root = workspace.path ?? 'Personal workspace'
  const relevantManifests = readPaths.filter((path) => manifests.includes(path.split('/').pop() ?? '')).map((path) => `- \`${path}\``).join('\n')
  onProgress('Building a structured report from repository metadata, files, and board notes…')
  return `# ${workspace.name} — Project brief

> Generated on this device from repository files and board notes. No repository content was sent to a provider.

## Workspace

- Location: \`${root}\`
- Files indexed: ${files.length}
- Folders: ${entries.filter((entry) => entry.directory).length}

## Overview

${overview || 'No README overview was found. Add a README to describe the project purpose and setup.'}

## Technology and commands

${[packageDetails, otherManifestDetails].filter(Boolean).join('\n\n') || (relevantManifests ? `Manifest files found:\n\n${relevantManifests}` : 'No supported project manifest was found. The file inventory below describes the repository structure.')}

## Top-level repository modules

${tree || '- No project files were found.'}

## File types

${typeSummary || '- No files were found.'}

## Board notes and decisions

${notes || 'No board notes have been added yet.'}

## Recommended next steps

${files.some((path) => /^readme(?:\.[^/]*)?$/i.test(path.split('/').pop() ?? '')) ? '- Review the README setup instructions and make sure the local development command works.' : '- Add a README with the project purpose, setup steps, and a quick verification command.'}
- Use the board to capture decisions and link those notes to repository work.
- Refresh this brief after major project structure or command changes.
`
}

export async function buildRepositoryFigure(workspace: Workspace, onProgress: (message: string) => void): Promise<RepoFigure> {
  if (!workspace.path) throw new Error('Open a local repository before generating a repository diagram.')
  const entries = await invoke<ProjectFile[]>('list_project_files', { path: workspace.path })
  const paths = entries.filter((entry) => !entry.directory && sourceExtensions.has(extension(entry.path))).map((entry) => entry.path)
  const available = new Set(paths)
  const importsByFile = new Map<string, string[]>()
  let complete = 0
  const concurrency = 10
  for (let offset = 0; offset < paths.length; offset += concurrency) {
    const batch = paths.slice(offset, offset + concurrency)
    const read = await Promise.all(batch.map(async (path) => {
      try {
        const content = await invoke<string>('read_project_file', { path: workspace.path, relativePath: path })
        return [path, localImportTargets(path, content, available)] as const
      } catch { return [path, [] as string[]] as const }
    }))
    for (const [path, targets] of read) importsByFile.set(path, targets)
    complete += batch.length
    onProgress(`Mapping local source relationships… ${complete} of ${paths.length} source files`)
  }

  const moduleFiles = new Map<string, string[]>()
  for (const path of paths) {
    const module = projectModule(path)
    const members = moduleFiles.get(module) ?? []
    members.push(path)
    moduleFiles.set(module, members)
  }
  const relationCounts = new Map<string, number>()
  for (const [source, targets] of importsByFile) {
    const from = projectModule(source)
    for (const target of targets) {
      const to = projectModule(target)
      if (from === to) continue
      const key = `${from}\u0000${to}`
      relationCounts.set(key, (relationCounts.get(key) ?? 0) + 1)
    }
  }
  const names = [...moduleFiles.keys()].sort((a, b) => a.localeCompare(b))
  const edges = [...relationCounts.entries()].map(([key, count]) => {
    const [from, to] = key.split('\u0000')
    return { from, to, count }
  })
  const { positions, degree } = layoutModules(names, edges)
  const margin = 150
  const raw = names.map((name) => positions.get(name)!)
  const minX = Math.min(0, ...raw.map((point) => point.x))
  const minY = Math.min(0, ...raw.map((point) => point.y))
  const width = Math.max(680, Math.max(...raw.map((point) => point.x)) - minX + margin * 2 + 220)
  const height = Math.max(430, Math.max(...raw.map((point) => point.y)) - minY + margin * 2 + 110)
  const points = new Map(names.map((name) => {
    const point = positions.get(name)!
    return [name, { x: point.x - minX + margin, y: point.y - minY + margin }]
  }))
  const arrowLines = edges.map(({ from, to, count }) => {
    const source = points.get(from)!
    const target = points.get(to)!
    return `<path d="M ${source.x} ${source.y} Q ${(source.x + target.x) / 2} ${(source.y + target.y) / 2 - 22} ${target.x} ${target.y}" fill="none" stroke="#946a52" stroke-opacity=".65" stroke-width="${Math.min(4, 1 + count * .45)}" marker-end="url(#repo-arrow)"/>`
  }).join('')
  const moduleNodes = names.map((name) => {
    const point = points.get(name)!
    const count = moduleFiles.get(name)?.length ?? 0
    const widthNode = Math.max(148, Math.min(250, 80 + name.length * 7))
    const heightNode = 72
    const label = name.length > 30 ? `${name.slice(0, 27)}…` : name
    return `<g><rect x="${point.x - widthNode / 2}" y="${point.y - heightNode / 2}" width="${widthNode}" height="${heightNode}" rx="12" fill="#1e1e20" stroke="#805d49" stroke-width="2"/><text x="${point.x}" y="${point.y - 5}" text-anchor="middle" font-size="15" fill="#f0d1bc">${xml(label)}</text><text x="${point.x}" y="${point.y + 18}" text-anchor="middle" font-size="10" fill="#a8a19b">${count} files · ${degree.get(name) ?? 0} links</text></g>`
  }).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><marker id="repo-arrow" markerWidth="10" markerHeight="8" refX="8" refY="4" orient="auto"><path d="M0,0 L0,8 L9,4 z" fill="#946a52"/></marker></defs><rect width="100%" height="100%" fill="#111214"/>${arrowLines}${moduleNodes}<text x="24" y="30" font-family="sans-serif" font-size="13" fill="#8f8e91">Repository modules · local relative imports · ${paths.length} source files scanned</text></svg>`
  return { svg, files: paths.length, modules: names.length, relationships: edges.length }
}
