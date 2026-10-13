import { useMemo } from 'react'
import hljs from 'highlight.js/lib/common'

const languageByExtension: Record<string, string> = {
  c: 'c', h: 'c', cc: 'cpp', cpp: 'cpp', hpp: 'cpp', cs: 'csharp', css: 'css', go: 'go', html: 'xml', xml: 'xml', java: 'java', js: 'javascript', jsx: 'javascript', json: 'json', kt: 'kotlin', md: 'markdown', mjs: 'javascript', php: 'php', py: 'python', rb: 'ruby', rs: 'rust', sh: 'bash', sql: 'sql', swift: 'swift', toml: 'toml', ts: 'typescript', tsx: 'typescript', vue: 'xml', yaml: 'yaml', yml: 'yaml',
}

export function CodePreview({ path, content }: { path: string; content: string }) {
  const highlighted = useMemo(() => {
    const extension = path.split('.').pop()?.toLowerCase() ?? ''
    const language = languageByExtension[extension]
    try {
      return language && hljs.getLanguage(language) ? hljs.highlight(content, { language, ignoreIllegals: true }).value : hljs.highlightAuto(content).value
    } catch {
      return hljs.highlightAuto(content).value
    }
  }, [path, content])
  return <pre className="studio-highlight"><code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
}
