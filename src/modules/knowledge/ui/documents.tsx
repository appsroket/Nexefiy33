'use client'

// Uploading and managing knowledge documents.
//
// Files go straight from the browser to the private knowledge bucket under the
// user's own session; storage policies only let operators write into their
// organization's folder. The server then confirms the file and queues it.

import { CircleAlert, CircleCheck, RefreshCw, Trash2, TriangleAlert, Upload } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'

import { ConfirmDialog } from '@/components/confirm-dialog'
import { DateTime } from '@/components/date-time'
import { StatusBadge } from '@/components/status-badge'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { getBrowserClient } from '@/lib/supabase/browser'

import { ACCEPT_ATTRIBUTE, checkFile, formatBytes, KNOWLEDGE_BUCKET, knowledgeStoragePath, MAX_FILES_PER_UPLOAD, SUPPORTED_FORMATS_LABEL } from '../domain/files'
import { deleteKnowledgeSource, registerKnowledgeUpload, reprocessKnowledgeSource } from '../server/actions'

interface UploadResult {
  name: string
  ok: boolean
  message: string
}

export function DocumentUpload({ organizationId }: { organizationId: string }) {
  const router = useRouter()
  const input = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [results, setResults] = useState<UploadResult[]>([])

  async function upload(files: File[]) {
    if (!files.length) return
    if (files.length > MAX_FILES_PER_UPLOAD) {
      setResults([{ name: 'Upload', ok: false, message: `Upload at most ${MAX_FILES_PER_UPLOAD} files at a time.` }])
      return
    }
    setBusy(true)
    const outcomes: UploadResult[] = []
    for (const file of files) {
      const check = checkFile(file.name, file.size)
      if (!check.ok) {
        outcomes.push({ name: file.name, ok: false, message: check.reason })
        continue
      }
      const uploadId = crypto.randomUUID()
      const path = knowledgeStoragePath(organizationId, uploadId, file.name)
      const { error } = await getBrowserClient().storage.from(KNOWLEDGE_BUCKET).upload(path, file, { contentType: check.type.mimeType, upsert: false })
      if (error) {
        outcomes.push({ name: file.name, ok: false, message: 'The upload was refused. You may not have permission, or the file is too large.' })
        continue
      }
      const result = await registerKnowledgeUpload({ organizationId, uploadId, path, name: file.name })
      outcomes.push({ name: file.name, ok: result.status === 'success', message: result.status === 'error' ? result.message : 'Uploaded. Processing has started.' })
    }
    setResults(outcomes)
    setBusy(false)
    if (input.current) input.current.value = ''
    router.refresh()
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col gap-2 rounded-lg border border-dashed p-6 text-center">
        <p className="text-sm text-muted-foreground">
          {SUPPORTED_FORMATS_LABEL}, up to 20 MB each. Documents are private to this workspace.
        </p>
        <div>
          <input
            ref={input}
            id="knowledge-upload"
            type="file"
            multiple
            accept={ACCEPT_ATTRIBUTE}
            className="sr-only"
            disabled={busy}
            onChange={(event) => upload(Array.from(event.target.files ?? []))}
          />
          <Button asChild disabled={busy}>
            <label htmlFor="knowledge-upload" className="cursor-pointer">
              {busy ? <Spinner data-icon="inline-start" aria-hidden="true" /> : <Upload data-icon="inline-start" aria-hidden="true" />}
              {busy ? 'Uploading…' : 'Upload documents'}
            </label>
          </Button>
        </div>
      </div>
      <div aria-live="polite" className="flex flex-col gap-2">
        {results.map((result, index) => (
          <Alert key={`${result.name}-${index}`} variant={result.ok ? 'default' : 'destructive'}>
            {result.ok ? <CircleCheck aria-hidden="true" /> : <CircleAlert aria-hidden="true" />}
            <AlertDescription>
              <span className="font-medium">{result.name}:</span> {result.message}
            </AlertDescription>
          </Alert>
        ))}
      </div>
    </div>
  )
}

export interface DocumentView {
  id: string
  name: string
  status: string
  byteSize: number | null
  chunkCount: number
  searchMode: 'hybrid' | 'keyword' | null
  errorMessage: string | null
  lastIndexedAt: string | null
  nextAttemptAt: string | null
  createdAt: string
  suspectedInstructionChunks: number
}

/** Refreshes the page every few seconds while anything is still processing. */
function useRefreshWhileProcessing(active: boolean) {
  const router = useRouter()
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => router.refresh(), 5000)
    return () => clearInterval(timer)
  }, [active, router])
}

export function DocumentsTable({
  organizationId,
  documents,
  canManage,
}: {
  organizationId: string
  documents: readonly DocumentView[]
  canManage: boolean
}) {
  const [error, setError] = useState<string | null>(null)
  useRefreshWhileProcessing(documents.some((document) => document.status === 'pending' || document.status === 'processing'))

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <Alert variant="destructive" role="alert">
          <CircleAlert aria-hidden="true" />
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div className="overflow-x-auto rounded-lg border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Document</TableHead>
              <TableHead className="w-40">Status</TableHead>
              <TableHead className="hidden w-28 md:table-cell">Size</TableHead>
              <TableHead className="hidden w-48 lg:table-cell">Indexed</TableHead>
              {canManage ? (
                <TableHead className="w-24">
                  <span className="sr-only">Actions</span>
                </TableHead>
              ) : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {documents.map((document) => (
              <TableRow key={document.id}>
                <TableCell className="max-w-xs align-top">
                  <div className="flex flex-col gap-1">
                    <span className="font-medium break-words">{document.name}</span>
                    {document.status === 'ready' ? (
                      <span className="text-xs text-muted-foreground">
                        {document.chunkCount} {document.chunkCount === 1 ? 'passage' : 'passages'} ·{' '}
                        {document.searchMode === 'hybrid' ? 'keyword and semantic search' : 'keyword search'}
                      </span>
                    ) : null}
                    {document.errorMessage ? <span className="text-xs text-destructive">{document.errorMessage}</span> : null}
                    {document.status === 'pending' && document.nextAttemptAt ? (
                      <span className="text-xs text-muted-foreground">
                        Next try <DateTime value={document.nextAttemptAt} />
                      </span>
                    ) : null}
                    {document.suspectedInstructionChunks > 0 ? (
                      <span className="flex items-start gap-1 text-xs text-warning">
                        <TriangleAlert className="mt-px size-3.5 shrink-0" aria-hidden="true" />
                        Contains text that reads like instructions to an AI. Employees treat it as information only.
                      </span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="align-top">
                  <StatusBadge kind="knowledgeSource" status={document.status} />
                </TableCell>
                <TableCell className="hidden align-top md:table-cell">{document.byteSize ? formatBytes(document.byteSize) : '—'}</TableCell>
                <TableCell className="hidden align-top lg:table-cell">{document.lastIndexedAt ? <DateTime value={document.lastIndexedAt} /> : '—'}</TableCell>
                {canManage ? (
                  <TableCell className="align-top">
                    <div className="flex gap-1">
                      {document.status === 'ready' || document.status === 'failed' ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          aria-label={`Reprocess ${document.name}`}
                          onClick={async () => {
                            const result = await reprocessKnowledgeSource(organizationId, document.id)
                            setError(result.status === 'error' ? result.message : null)
                          }}
                        >
                          <RefreshCw aria-hidden="true" />
                        </Button>
                      ) : null}
                      <ConfirmDialog
                        trigger={
                          <Button variant="ghost" size="icon" aria-label={`Delete ${document.name}`}>
                            <Trash2 aria-hidden="true" />
                          </Button>
                        }
                        title={`Delete ${document.name}?`}
                        description="The file and everything indexed from it are removed. AI employees will no longer find it."
                        confirmLabel="Delete"
                        destructive
                        onConfirm={() => deleteKnowledgeSource(organizationId, document.id)}
                      />
                    </div>
                  </TableCell>
                ) : null}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
    </div>
  )
}
