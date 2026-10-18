// Text extraction for supported knowledge documents. Returns structured
// blocks (text, page, heading path) for the chunker.
//
// Files are untrusted input: sizes are capped before parsing, extracted text
// is capped after, and failures become plain-language messages for the
// person who uploaded the file. Nothing in a file is executed or followed.

import 'server-only'

import type { ExtractedBlock } from '../domain/chunking'
import type { DocumentFormat } from '../domain/files'

/** Longest text kept from one document (about 500 pages of prose). */
export const MAX_EXTRACTED_CHARS = 2_000_000
const MAX_CSV_ROWS = 20_000

/** A problem with the file itself: retrying won't help. The message is shown to people. */
export class ExtractionError extends Error {
  override name = 'ExtractionError'
}

export interface ExtractionResult {
  blocks: ExtractedBlock[]
  pageCount?: number
  charCount: number
}

export async function extractDocument(bytes: Uint8Array, format: DocumentFormat): Promise<ExtractionResult> {
  let blocks: ExtractedBlock[]
  let pageCount: number | undefined
  switch (format) {
    case 'pdf': {
      const result = await extractPdf(bytes)
      blocks = result.blocks
      pageCount = result.pageCount
      break
    }
    case 'docx':
      blocks = htmlToBlocks(await docxToHtml(bytes))
      break
    case 'html':
      blocks = htmlToBlocks(decodeText(bytes))
      break
    case 'markdown':
      blocks = markdownToBlocks(decodeText(bytes))
      break
    case 'csv':
      blocks = csvToBlocks(decodeText(bytes))
      break
    case 'text':
      blocks = textToBlocks(decodeText(bytes))
      break
  }
  const limited = limitBlocks(blocks)
  const charCount = limited.reduce((total, block) => total + block.text.length, 0)
  if (charCount < 10) {
    throw new ExtractionError(
      format === 'pdf'
        ? 'No text was found in this PDF. Scanned documents (pictures of pages) aren’t supported yet.'
        : 'No text was found in this file.',
    )
  }
  return { blocks: limited, ...(pageCount === undefined ? {} : { pageCount }), charCount }
}

function limitBlocks(blocks: ExtractedBlock[]): ExtractedBlock[] {
  const kept: ExtractedBlock[] = []
  let total = 0
  for (const block of blocks) {
    const text = block.text.trim()
    if (!text) continue
    if (total + text.length > MAX_EXTRACTED_CHARS) {
      throw new ExtractionError('This document has too much text to index. Split it into smaller files.')
    }
    total += text.length
    kept.push({ ...block, text })
  }
  return kept
}

// Text ------------------------------------------------------------------------

export function decodeText(bytes: Uint8Array): string {
  const text = new TextDecoder('utf-8', { fatal: false }).decode(bytes).replace(/^﻿/, '')
  const sample = text.slice(0, 20000)
  const replacements = (sample.match(/�/g) ?? []).length
  const nuls = (sample.match(/\u0000/g) ?? []).length
  if (sample.length && (replacements + nuls) / sample.length > 0.05) {
    throw new ExtractionError('This file doesn’t look like text. Check that it is saved as UTF-8 text.')
  }
  return text
}

export function textToBlocks(text: string): ExtractedBlock[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean)
    .map((paragraph) => ({ text: paragraph }))
}

// Markdown --------------------------------------------------------------------

function stripInlineMarkdown(line: string): string {
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)\s]+)[^)]*\)/g, '$1 ($2)')
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(^|\W)[*_](\S.*?\S|\S)[*_](?=\W|$)/g, '$1$2')
    .replace(/`([^`]+)`/g, '$1')
}

export function markdownToBlocks(markdown: string): ExtractedBlock[] {
  const blocks: ExtractedBlock[] = []
  const headings: string[] = []
  let paragraph: string[] = []
  let inFence = false

  const flush = () => {
    const text = paragraph.join('\n').trim()
    if (text) blocks.push({ text, ...(headings.length ? { headingPath: [...headings] } : {}) })
    paragraph = []
  }

  for (const rawLine of markdown.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*(```|~~~)/.test(rawLine)) {
      inFence = !inFence
      continue
    }
    if (inFence) {
      paragraph.push(rawLine)
      continue
    }
    const heading = /^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(rawLine)
    if (heading) {
      flush()
      const level = heading[1]!.length
      headings.splice(level - 1)
      while (headings.length < level - 1) headings.push('')
      headings.push(stripInlineMarkdown(heading[2]!))
      // Drop placeholder levels (a "###" directly under a "#").
      for (let index = headings.length - 1; index >= 0; index -= 1) if (!headings[index]) headings.splice(index, 1)
      continue
    }
    if (!rawLine.trim()) {
      flush()
      continue
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(rawLine)) {
      flush()
      continue
    }
    paragraph.push(stripInlineMarkdown(rawLine.replace(/^\s*>\s?/, '').replace(/^\s*[-*+]\s+/, '• ').replace(/^\s*\|/, '').replace(/\|\s*$/, '')))
  }
  flush()
  return blocks
}

// HTML (also used for .docx, converted by mammoth) --------------------------------

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '–',
  mdash: '—',
  hellip: '…',
  rsquo: '’',
  lsquo: '‘',
  rdquo: '”',
  ldquo: '“',
  copy: '©',
  reg: '®',
  euro: '€',
  pound: '£',
}

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity[0] === '#') {
      const code = entity[1]?.toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10)
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match
  })
}

const BLOCK_TAGS = new Set([
  'p', 'div', 'section', 'article', 'header', 'footer', 'main', 'aside', 'nav', 'blockquote', 'pre', 'ul', 'ol', 'li',
  'table', 'thead', 'tbody', 'tr', 'dl', 'dt', 'dd', 'figure', 'figcaption', 'form', 'fieldset', 'address', 'hr', 'br',
])

/**
 * Text and structure from HTML: headings become the heading path, block
 * elements separate paragraphs, table cells are separated by " | ". Scripts,
 * styles and comments are dropped. This reads text; it never renders or runs
 * the HTML.
 */
export function htmlToBlocks(html: string): ExtractedBlock[] {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|head|svg|iframe|object)\b[\s\S]*?<\/\1\s*>/gi, ' ')
  const blocks: ExtractedBlock[] = []
  const headings: string[] = []
  let text = ''
  let headingLevel = 0
  let headingText = ''

  const flush = () => {
    const value = decodeEntities(text).replace(/[ \t\n\r]+/g, ' ').trim()
    if (value) blocks.push({ text: value, ...(headings.length ? { headingPath: [...headings] } : {}) })
    text = ''
  }

  const tokens = cleaned.split(/(<\/?[a-zA-Z][^>]*>)/)
  for (const token of tokens) {
    const tag = /^<(\/?)([a-zA-Z][a-zA-Z0-9]*)/.exec(token)
    if (!tag) {
      if (headingLevel) headingText += token
      else text += token
      continue
    }
    const closing = tag[1] === '/'
    const name = tag[2]!.toLowerCase()
    const heading = /^h([1-6])$/.exec(name)
    if (heading) {
      if (!closing) {
        flush()
        headingLevel = Number(heading[1])
        headingText = ''
      } else if (headingLevel) {
        const value = decodeEntities(headingText).replace(/\s+/g, ' ').trim()
        if (value) {
          headings.splice(Math.min(headingLevel - 1, headings.length))
          headings.push(value)
        }
        headingLevel = 0
      }
      continue
    }
    if (name === 'td' || name === 'th') {
      if (closing) text += ' | '
      continue
    }
    if (BLOCK_TAGS.has(name)) {
      if (name === 'li' && !closing) {
        flush()
        text = '• '
      } else if (name === 'tr' || name === 'br') {
        text = text.replace(/\s*\|\s*$/, '')
        if (name === 'tr' && closing) flush()
        else text += '\n'
      } else {
        flush()
      }
    }
  }
  flush()
  return blocks.map((block) => ({ ...block, text: block.text.replace(/\s*\|\s*$/, '') })).filter((block) => block.text && block.text !== '•')
}

async function docxToHtml(bytes: Uint8Array): Promise<string> {
  const mammoth = await import('mammoth')
  try {
    const result = await mammoth.convertToHtml({ buffer: Buffer.from(bytes) })
    return result.value
  } catch {
    throw new ExtractionError('This Word document couldn’t be read. Check that it is a .docx file and not password-protected.')
  }
}

// PDF -----------------------------------------------------------------------------

async function extractPdf(bytes: Uint8Array): Promise<{ blocks: ExtractedBlock[]; pageCount: number }> {
  const { extractText, getDocumentProxy } = await import('unpdf')
  let pages: string[]
  let pageCount: number
  try {
    // pdf.js may transfer (detach) the buffer it is given, so pass a copy.
    const document = await getDocumentProxy(new Uint8Array(bytes))
    const result = await extractText(document, { mergePages: false })
    pages = result.text
    pageCount = result.totalPages
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    if (name === 'PasswordException') throw new ExtractionError('This PDF is password-protected. Remove the password and upload it again.')
    throw new ExtractionError('This PDF couldn’t be read. It may be damaged or not a PDF.')
  }
  const blocks: ExtractedBlock[] = []
  pages.forEach((pageText, index) => {
    for (const paragraph of pageText.split(/\n\s*\n|(?<=[.!?:])\n(?=[A-Z0-9•\-])/)) {
      const text = paragraph.replace(/-\n(?=[a-z])/g, '').replace(/\s*\n\s*/g, ' ').trim()
      if (text) blocks.push({ text, page: index + 1 })
    }
  })
  return { blocks, pageCount }
}

// CSV -----------------------------------------------------------------------------

/** RFC 4180-style CSV parsing (quoted fields, escaped quotes, newlines in quotes). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]!
    if (quoted) {
      if (character === '"') {
        if (text[index + 1] === '"') {
          field += '"'
          index += 1
        } else quoted = false
      } else field += character
      continue
    }
    if (character === '"' && field === '') quoted = true
    else if (character === ',') {
      row.push(field)
      field = ''
    } else if (character === '\n' || character === '\r') {
      if (character === '\r' && text[index + 1] === '\n') index += 1
      row.push(field)
      if (row.some((cell) => cell.trim())) rows.push(row)
      row = []
      field = ''
      if (rows.length > MAX_CSV_ROWS + 1) throw new ExtractionError(`CSV files can have up to ${MAX_CSV_ROWS} rows.`)
    } else field += character
  }
  row.push(field)
  if (row.some((cell) => cell.trim())) rows.push(row)
  return rows
}

/** One block per row, written as "Column: value" pairs so each row stands on its own. */
export function csvToBlocks(text: string): ExtractedBlock[] {
  const rows = parseCsv(text)
  if (rows.length === 0) return []
  const header = rows[0]!.map((cell, index) => cell.trim() || `Column ${index + 1}`)
  if (rows.length === 1) return [{ text: header.join(', ') }]
  return rows.slice(1).map((row) => ({
    text: row
      .map((cell, index) => (cell.trim() ? `${header[index] ?? `Column ${index + 1}`}: ${cell.trim()}` : ''))
      .filter(Boolean)
      .join('; '),
  }))
}
