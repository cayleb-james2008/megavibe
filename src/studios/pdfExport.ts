import { jsPDF } from 'jspdf'

function asciiText(value: string) {
  return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/[—–]/g, '-').replace(/…/g, '...').replace(/•/g, '-').replace(/→/g, '->').replace(/✓/g, '[x]').replace(/☐/g, '[ ]').replace(/[^\x09\x0A\x0D\x20-\x7E]/g, '?')
}

export function downloadMarkdownPdf(title: string, markdown: string) {
  const pdf = new jsPDF({ unit: 'pt', format: 'a4', compress: true })
  const pageWidth = pdf.internal.pageSize.getWidth()
  const pageHeight = pdf.internal.pageSize.getHeight()
  const margin = 54
  const usableWidth = pageWidth - margin * 2
  let y = 58
  let codeBlock = false

  const addPageIfNeeded = (height: number) => {
    if (y + height <= pageHeight - 54) return
    pdf.addPage()
    y = 54
  }
  const writeWrapped = (value: string, size: number, weight: 'normal' | 'bold', color: [number, number, number], indent = 0) => {
    pdf.setFont('helvetica', weight)
    pdf.setFontSize(size)
    pdf.setTextColor(...color)
    const lines = pdf.splitTextToSize(asciiText(value), usableWidth - indent) as string[]
    const lineHeight = size * 1.42
    for (const line of lines) {
      addPageIfNeeded(lineHeight)
      pdf.text(line, margin + indent, y)
      y += lineHeight
    }
  }

  for (const rawLine of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trimEnd()
    if (/^\s*```/.test(line)) {
      codeBlock = !codeBlock
      y += 4
      continue
    }
    if (!line.trim()) {
      y += codeBlock ? 3 : 6
      continue
    }
    if (codeBlock) {
      writeWrapped(line, 8.5, 'normal', [72, 76, 82], 8)
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      y += 7
      const level = heading[1].length
      writeWrapped(heading[2], [20, 16, 13, 11][level - 1], 'bold', [139, 86, 61])
      y += 3
      continue
    }
    const quote = /^>\s?(.*)$/.exec(line)
    if (quote) {
      writeWrapped(quote[1], 9.5, 'normal', [105, 98, 91], 10)
      continue
    }
    const bullet = /^\s*(?:[-*+]\s+|\d+[.)]\s+)(.*)$/.exec(line)
    if (bullet) {
      writeWrapped(`- ${bullet[1]}`, 9.5, 'normal', [52, 52, 52], 8)
      continue
    }
    const cleaned = line.replace(/`([^`]+)`/g, '$1').replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*(.+?)\*/g, '$1').replace(/\[(.*?)\]\([^)]*\)/g, '$1')
    writeWrapped(cleaned, 9.5, 'normal', [52, 52, 52])
  }

  const pageCount = pdf.getNumberOfPages()
  for (let page = 1; page <= pageCount; page += 1) {
    pdf.setPage(page)
    pdf.setDrawColor(221, 218, 214)
    pdf.line(margin, pageHeight - 38, pageWidth - margin, pageHeight - 38)
    pdf.setFont('helvetica', 'normal')
    pdf.setFontSize(8)
    pdf.setTextColor(133, 130, 126)
    pdf.text(asciiText(title), margin, pageHeight - 23)
    pdf.text(`${page} / ${pageCount}`, pageWidth - margin, pageHeight - 23, { align: 'right' })
  }
  const slug = title.normalize('NFKD').replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'document'
  pdf.save(`${slug}.pdf`)
}
