// Supported knowledge document formats and storage paths. Pure rules shared by
// the upload form (client), the upload registration action and the processing
// worker. The bucket's own allowed MIME types and size limit (migration
// knowledge_pipeline) enforce the same list on the storage side.

export const KNOWLEDGE_BUCKET = 'knowledge'
export const MAX_FILE_BYTES = 20 * 1024 * 1024
export const MAX_FILES_PER_UPLOAD = 10

export type DocumentFormat = 'pdf' | 'docx' | 'text' | 'markdown' | 'csv' | 'html'

export interface DocumentType {
  format: DocumentFormat
  label: string
  extensions: readonly string[]
  /** The content type the file is stored with (one of the bucket's allowed types). */
  mimeType: string
}

export const DOCUMENT_TYPES: readonly DocumentType[] = [
  { format: 'pdf', label: 'PDF', extensions: ['pdf'], mimeType: 'application/pdf' },
  {
    format: 'docx',
    label: 'Word (.docx)',
    extensions: ['docx'],
    mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  },
  { format: 'text', label: 'Plain text', extensions: ['txt'], mimeType: 'text/plain' },
  { format: 'markdown', label: 'Markdown', extensions: ['md', 'markdown'], mimeType: 'text/markdown' },
  { format: 'csv', label: 'CSV', extensions: ['csv'], mimeType: 'text/csv' },
  { format: 'html', label: 'HTML', extensions: ['html', 'htm'], mimeType: 'text/html' },
]

/** For the file picker's `accept` attribute. */
export const ACCEPT_ATTRIBUTE = DOCUMENT_TYPES.flatMap((type) => type.extensions.map((extension) => `.${extension}`)).join(',')

export const SUPPORTED_FORMATS_LABEL = 'PDF, Word (.docx), plain text, Markdown, CSV and HTML'

export function fileExtension(fileName: string): string {
  const match = /\.([A-Za-z0-9]{1,10})$/.exec(fileName.trim())
  return match ? match[1]!.toLowerCase() : ''
}

/** Decided by the extension; the browser-reported type is unreliable (often empty for .md). */
export function documentTypeFor(fileName: string): DocumentType | undefined {
  const extension = fileExtension(fileName)
  return DOCUMENT_TYPES.find((type) => type.extensions.includes(extension))
}

export function documentTypeForMime(mimeType: string | null | undefined): DocumentType | undefined {
  const base = (mimeType ?? '').split(';')[0]!.trim().toLowerCase()
  return DOCUMENT_TYPES.find((type) => type.mimeType === base)
}

export type FileCheck = { ok: true; type: DocumentType } | { ok: false; reason: string }

export function checkFile(fileName: string, byteSize: number): FileCheck {
  const type = documentTypeFor(fileName)
  if (!type) return { ok: false, reason: `This file type isn’t supported. Upload ${SUPPORTED_FORMATS_LABEL}.` }
  if (byteSize <= 0) return { ok: false, reason: 'This file is empty.' }
  if (byteSize > MAX_FILE_BYTES) return { ok: false, reason: 'Files can be up to 20 MB.' }
  return { ok: true, type }
}

/**
 * A storage-safe version of a file name: keeps letters, digits, dots, dashes
 * and underscores, collapses the rest, and keeps the extension. The display
 * name stored on the source keeps the original.
 */
export function safeFileName(fileName: string): string {
  const extension = fileExtension(fileName)
  const stem = fileName
    .trim()
    .replace(/\.[A-Za-z0-9]{1,10}$/, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 120)
  return `${stem || 'document'}${extension ? `.${extension}` : ''}`
}

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'

/** <organization id>/<upload id>/<safe file name> */
export function knowledgeStoragePath(organizationId: string, uploadId: string, fileName: string): string {
  return `${organizationId}/${uploadId}/${safeFileName(fileName)}`
}

/** True only for a path this app would have produced for the organization. */
export function isOrganizationStoragePath(path: string, organizationId: string): boolean {
  const match = new RegExp(`^(${UUID})/(${UUID})/([\\w][\\w.-]{0,140})$`).exec(path)
  return Boolean(match && match[1] === organizationId.toLowerCase() && !match[3]!.includes('..'))
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}
