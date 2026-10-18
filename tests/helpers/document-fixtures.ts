// Builds small real documents at runtime for extraction tests, so no binary
// fixtures are committed.

import JSZip from 'jszip'

/** A minimal valid PDF with one text line per page (Helvetica, uncompressed). */
export function buildPdf(pages: readonly string[]): Uint8Array {
  const objects: string[] = []
  const add = (body: string) => objects.push(body)
  add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  const pagesId = 2 + pages.length * 2
  const pageIds: number[] = []
  for (const text of pages) {
    const escaped = text.replace(/[\\()]/g, (character) => `\\${character}`)
    const stream = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET`
    add(`<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
    const contentId = objects.length
    add(`<< /Type /Page /Parent ${pagesId} 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 1 0 R >> >> /Contents ${contentId} 0 R >>`)
    pageIds.push(objects.length)
  }
  add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`)
  add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`)
  const catalogId = objects.length

  let output = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, index) => {
    offsets.push(output.length)
    output += `${index + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = output.length
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  output += offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('')
  output += `trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xref}\n%%EOF`
  return new TextEncoder().encode(output)
}

/** A minimal .docx. Paragraphs starting with "# " become Heading 1. */
export async function buildDocx(paragraphs: readonly string[]): Promise<Uint8Array> {
  const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const body = paragraphs
    .map((paragraph) =>
      paragraph.startsWith('# ')
        ? `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${escape(paragraph.slice(2))}</w:t></w:r></w:p>`
        : `<w:p><w:r><w:t xml:space="preserve">${escape(paragraph)}</w:t></w:r></w:p>`,
    )
    .join('')
  const zip = new JSZip()
  zip.file(
    '[Content_Types].xml',
    '<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
  )
  zip.file(
    '_rels/.rels',
    '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
  )
  zip.file(
    'word/document.xml',
    `<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`,
  )
  return new Uint8Array(await zip.generateAsync({ type: 'uint8array' }))
}
