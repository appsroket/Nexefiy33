// Splits extracted document text into retrieval chunks. Pure and
// deterministic: the same blocks always produce the same chunks.
//
// Chunks follow the document's structure: a new section (heading) starts a new
// chunk once the current one has some substance, paragraphs are packed up to a
// target size, oversized paragraphs are split at sentence boundaries, and
// consecutive chunks in one section overlap slightly so a fact that straddles
// a boundary is still found. Each chunk keeps where it came from (pages,
// heading path, character offsets) so answers can cite it.

export interface ExtractedBlock {
  text: string
  /** 1-based page number, for paginated formats. */
  page?: number
  /** Headings above this block, outermost first. */
  headingPath?: readonly string[]
}

export interface ChunkMetadata {
  pageStart?: number
  pageEnd?: number
  headingPath?: string[]
  charStart: number
  charEnd: number
}

export interface Chunk {
  index: number
  content: string
  tokenCount: number
  metadata: ChunkMetadata
}

export interface ChunkOptions {
  targetChars: number
  maxChars: number
  minChars: number
  overlapChars: number
  maxChunks: number
}

export const DEFAULT_CHUNK_OPTIONS: ChunkOptions = {
  targetChars: 1600,
  maxChars: 2400,
  minChars: 300,
  overlapChars: 200,
  maxChunks: 2000,
}

export class TooManyChunksError extends Error {
  override name = 'TooManyChunksError'
}

/** A rough token count (about four characters per token for English text). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4))
}

export function normalizeWhitespace(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
    .replace(/[ \t ]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/** Splits text longer than maxChars at sentence ends, then at spaces, then hard. */
export function splitLongText(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text]
  const sentences = text.split(/(?<=[.!?。])\s+|\n+/).filter(Boolean)
  const pieces: string[] = []
  let current = ''
  const push = () => {
    if (current.trim()) pieces.push(current.trim())
    current = ''
  }
  for (const sentence of sentences) {
    if (sentence.length > maxChars) {
      push()
      let rest = sentence
      while (rest.length > maxChars) {
        const cut = rest.lastIndexOf(' ', maxChars)
        const at = cut > maxChars / 2 ? cut : maxChars
        pieces.push(rest.slice(0, at).trim())
        rest = rest.slice(at).trim()
      }
      current = rest
      continue
    }
    if (current && current.length + 1 + sentence.length > maxChars) push()
    current = current ? `${current} ${sentence}` : sentence
  }
  push()
  return pieces
}

/** The tail of `text`, starting at a sentence or word boundary, at most `chars` long. */
function overlapTail(text: string, chars: number): string {
  if (chars <= 0 || text.length <= chars) return chars <= 0 ? '' : text
  const tail = text.slice(-chars)
  const sentence = tail.search(/(?<=[.!?])\s+\S/)
  if (sentence >= 0) return tail.slice(sentence).trim()
  const space = tail.indexOf(' ')
  return space >= 0 ? tail.slice(space + 1) : tail
}

function samePath(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  return (a ?? []).join('\u0000') === (b ?? []).join('\u0000')
}

interface Piece {
  text: string
  page?: number
  headingPath?: readonly string[]
  charStart: number
  charEnd: number
}

export function chunkBlocks(blocks: readonly ExtractedBlock[], options: ChunkOptions = DEFAULT_CHUNK_OPTIONS): Chunk[] {
  // Flatten into pieces no longer than maxChars, tracking offsets in the
  // document text (blocks joined by blank lines).
  const pieces: Piece[] = []
  let offset = 0
  for (const block of blocks) {
    const text = normalizeWhitespace(block.text)
    if (!text) continue
    let cursor = offset
    for (const part of splitLongText(text, options.maxChars)) {
      const start = text.indexOf(part.slice(0, 20), cursor - offset)
      const charStart = offset + Math.max(start, 0)
      pieces.push({ text: part, page: block.page, headingPath: block.headingPath, charStart, charEnd: charStart + part.length })
      cursor = charStart + part.length
    }
    offset += text.length + 2
  }

  const chunks: Chunk[] = []
  let parts: Piece[] = []
  let overlap = ''

  const flush = () => {
    if (!parts.length) return
    const first = parts[0]!
    const last = parts[parts.length - 1]!
    const headingPath = first.headingPath?.length ? [...first.headingPath] : undefined
    const body = parts.map((part) => part.text).join('\n\n')
    const heading = headingPath ? `${headingPath.join(' › ')}\n\n` : ''
    const content = `${heading}${overlap ? `${overlap}\n\n` : ''}${body}`
    const pages = parts.map((part) => part.page).filter((page): page is number => page !== undefined)
    if (chunks.length >= options.maxChunks) {
      throw new TooManyChunksError(`More than ${options.maxChunks} chunks`)
    }
    chunks.push({
      index: chunks.length,
      content,
      tokenCount: estimateTokens(content),
      metadata: {
        ...(pages.length ? { pageStart: Math.min(...pages), pageEnd: Math.max(...pages) } : {}),
        ...(headingPath ? { headingPath } : {}),
        charStart: first.charStart,
        charEnd: last.charEnd,
      },
    })
    overlap = overlapTail(body, options.overlapChars)
    parts = []
  }

  for (const piece of pieces) {
    const size = parts.reduce((total, part) => total + part.text.length + 2, 0)
    const sectionChanged = parts.length > 0 && !samePath(parts[0]!.headingPath, piece.headingPath)
    if (sectionChanged && size >= options.minChars) {
      flush()
      overlap = ''
    } else if (parts.length && size + piece.text.length > options.targetChars) {
      flush()
      if (!samePath(piece.headingPath, chunks[chunks.length - 1]?.metadata.headingPath)) overlap = ''
    }
    parts.push(piece)
  }
  flush()
  return chunks
}
