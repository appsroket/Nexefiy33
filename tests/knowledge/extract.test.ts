// Text extraction from real (runtime-built) documents in every supported format.

import { describe, expect, it } from 'vitest'

import { csvToBlocks, extractDocument, ExtractionError, htmlToBlocks, markdownToBlocks, parseCsv } from '@/modules/knowledge/server/extract'

import { buildDocx, buildPdf } from '../helpers/document-fixtures'

const encode = (text: string) => new TextEncoder().encode(text)

describe('extractDocument', () => {
  it('reads PDF text page by page', async () => {
    const result = await extractDocument(buildPdf(['Refunds are accepted within 30 days.', 'Shipping takes 3 working days.']), 'pdf')
    expect(result.pageCount).toBe(2)
    expect(result.blocks).toEqual([
      { text: 'Refunds are accepted within 30 days.', page: 1 },
      { text: 'Shipping takes 3 working days.', page: 2 },
    ])
  })

  it('explains a damaged PDF instead of failing obscurely', async () => {
    await expect(extractDocument(encode('%PDF-1.4 not really a pdf'), 'pdf')).rejects.toThrow(ExtractionError)
  })

  it('reports PDFs without text (scans) plainly', async () => {
    await expect(extractDocument(buildPdf(['']), 'pdf')).rejects.toThrow(/Scanned documents/)
  })

  it('reads Word documents with their headings', async () => {
    const result = await extractDocument(await buildDocx(['# Returns', 'Refunds are accepted within 30 days.', 'Keep the receipt.']), 'docx')
    expect(result.blocks).toEqual([
      { text: 'Refunds are accepted within 30 days.', headingPath: ['Returns'] },
      { text: 'Keep the receipt.', headingPath: ['Returns'] },
    ])
  })

  it('rejects a file that is not really a Word document', async () => {
    await expect(extractDocument(encode('plain text pretending'), 'docx')).rejects.toThrow(/couldn’t be read/)
  })

  it('reads plain text by paragraph and rejects binary content', async () => {
    const result = await extractDocument(encode('﻿First paragraph.\n\nSecond paragraph.'), 'text')
    expect(result.blocks.map((block) => block.text)).toEqual(['First paragraph.', 'Second paragraph.'])
    await expect(extractDocument(new Uint8Array(200).fill(0), 'text')).rejects.toThrow(/doesn’t look like text/)
  })

  it('rejects empty files', async () => {
    await expect(extractDocument(encode('   \n  '), 'text')).rejects.toThrow(/No text was found/)
  })
})

describe('markdownToBlocks', () => {
  it('tracks nested headings and strips formatting', () => {
    const blocks = markdownToBlocks('# Policies\n\nIntro **text**.\n\n## Refunds\n\n- Within [30 days](https://example.com/r)\n- Keep `receipt`\n\n# Shipping\n\nFast.')
    expect(blocks).toEqual([
      { text: 'Intro text.', headingPath: ['Policies'] },
      { text: '• Within 30 days (https://example.com/r)\n• Keep receipt', headingPath: ['Policies', 'Refunds'] },
      { text: 'Fast.', headingPath: ['Shipping'] },
    ])
  })

  it('keeps fenced code as text without treating # lines as headings', () => {
    expect(markdownToBlocks('```\n# not a heading\n```')).toEqual([{ text: '# not a heading' }])
  })
})

describe('htmlToBlocks', () => {
  it('drops scripts, styles and comments and keeps structure', () => {
    const blocks = htmlToBlocks(
      '<html><head><title>x</title><style>p{}</style></head><body><script>alert(1)</script><!-- hidden --><h1>Help</h1><p>Call us &amp; we&#39;ll help.</p><h2>Hours</h2><ul><li>Mon</li><li>Tue</li></ul><table><tr><th>Day</th><th>Open</th></tr><tr><td>Mon</td><td>9</td></tr></table></body></html>',
    )
    expect(blocks).toEqual([
      { text: "Call us & we'll help.", headingPath: ['Help'] },
      { text: '• Mon', headingPath: ['Help', 'Hours'] },
      { text: '• Tue', headingPath: ['Help', 'Hours'] },
      { text: 'Day | Open', headingPath: ['Help', 'Hours'] },
      { text: 'Mon | 9', headingPath: ['Help', 'Hours'] },
    ])
    expect(JSON.stringify(blocks)).not.toContain('alert')
  })
})

describe('CSV', () => {
  it('parses quoted fields, escaped quotes and newlines', () => {
    expect(parseCsv('a,b\n"x, y","he said ""hi""\nthere"\r\n')).toEqual([
      ['a', 'b'],
      ['x, y', 'he said "hi"\nthere'],
    ])
  })

  it('turns each row into self-contained column: value text', () => {
    expect(csvToBlocks('Plan,Price,Notes\nStarter,49 EUR,\nPro,99 EUR,Most popular')).toEqual([
      { text: 'Plan: Starter; Price: 49 EUR' },
      { text: 'Plan: Pro; Price: 99 EUR; Notes: Most popular' },
    ])
  })
})
