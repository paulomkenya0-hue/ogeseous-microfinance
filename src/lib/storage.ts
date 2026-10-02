import { supabase } from './supabase'
import type { AppDocType } from './application'

export const BUCKET = 'verification-documents'

/**
 * The bucket's own allowlist, mirrored from the migration 011 UPDATE on storage.buckets so the
 * browser can reject a wrong file before spending the user's bandwidth. It is a convenience, not
 * the control: the server enforces the same list and the 5MB cap, and this constant must be kept
 * in step with it.
 */
export const MAX_BYTES = 5 * 1024 * 1024
export const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'application/pdf']

const EXT_FOR_TYPE: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/heic': 'heic',
  'application/pdf': 'pdf',
}

export type DocKind = 'certificate' | 'id' | 'passport'

export const DOC_LABELS: Record<DocKind, string> = {
  certificate: 'Form Four certificate',
  id: 'Identity document',
  passport: 'Passport photo',
}

/**
 * Returns a reason string if the file cannot be used, or null if it is fine. The old code only
 * checked size, and took the extension straight from the filename — so "passport.php.exe" and a
 * 400MB archive both went through, and the extension is what the bucket stores.
 */
export function fileProblem(f: File | null | undefined): string | null {
  if (!f) return 'This file is required'
  if (f.size > MAX_BYTES) return `Must be ${MAX_BYTES / 1024 / 1024}MB or smaller`
  if (f.size === 0) return 'This file is empty'
  if (!ALLOWED_TYPES.includes(f.type)) return 'Use a JPEG, PNG, WebP, HEIC image or a PDF'
  return null
}

/**
 * Uploads into the caller's own folder, which is what satisfies the storage policies.
 * The path is built entirely from values we control — the kind, a timestamp and an extension
 * derived from the MIME type — so nothing the user typed in a filename reaches the object key.
 */
export async function uploadVerificationFile(userId: string, kind: DocKind, file: File): Promise<string> {
  const problem = fileProblem(file)
  if (problem) throw new Error(problem)

  const ext = EXT_FOR_TYPE[file.type] ?? 'bin'
  const path = `${userId}/${kind}-${Date.now()}.${ext}`
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    upsert: false,
    contentType: file.type,
    cacheControl: '3600',
  })
  if (error) throw new Error(error.message)
  return path
}

/**
 * Best-effort cleanup after a failed submission. Without it, a student who uploads three files
 * and then hits the "you already have a request pending" error is left with documents in the
 * bucket that nothing will ever reference.
 */
/**
 * Keeps only the paths that lie inside this user's own folder.
 *
 * The storage policies already prevent one student deleting another's documents, but this function
 * deletes, and `paths` arrives from the caller. A caller that ever assembled that list from
 * somewhere other than its own upload results should not be able to ask for someone else's
 * documents to disappear — so the paths are filtered here too, and the filter is unit-tested.
 */
export function ownPaths(userId: string, paths: string[]): string[] {
  const prefix = `${userId}/`
  return paths.filter((p) => p.startsWith(prefix))
}

export async function discardUploads(userId: string, paths: string[]): Promise<void> {
  const mine = ownPaths(userId, paths)
  if (mine.length === 0) return

  try {
    await supabase.storage.from(BUCKET).remove(mine)
  } catch {
    // Deliberately swallowed: this is a courtesy cleanup, and the user's real error matters more.
  }
}

// ---------------------------------------------------------------------------------------
// Loan application documents
// ---------------------------------------------------------------------------------------

/**
 * Uploads a wizard document into the student's own folder.
 *
 * Same bucket and same allowlist as the old verification uploads — no new bucket, so no new bucket
 * policy to keep in step. The path is built the same way: a folder named after the caller's id,
 * a fixed prefix, a timestamp and an extension derived from the MIME type. Nothing the user typed
 * in a filename reaches the object key, so a crafted filename cannot escape the folder or change
 * the stored content type.
 *
 * The application id is in the filename purely so a human reading the bucket can tell whose file is
 * whose. The server does not trust it: attach_application_document() re-checks that the object
 * exists in the caller's own folder before it records anything.
 */
export async function uploadApplicationDocument(
  userId: string,
  applicationId: string,
  docType: AppDocType,
  file: File,
): Promise<string> {
  const problem = fileProblem(file)
  if (problem) throw new Error(problem)

  const ext = EXT_FOR_TYPE[file.type] ?? 'bin'
  const path = `${userId}/app-${docType.toLowerCase()}-${applicationId.slice(0, 8)}-${Date.now()}.${ext}`
  const { error } = await supabase.storage.from(BUCKET).upload(path, file, {
    upsert: false,
    contentType: file.type,
    cacheControl: '3600',
  })
  if (error) throw new Error(error.message)
  return path
}

/**
 * A short-lived read URL for a document, for the student themself or for a staff reviewer.
 *
 * Never a public URL: the bucket is private, and that is deliberate. A permanent link to somebody's
 * National ID is a link that ends up in a chat group a year later, so the URL is minted on demand
 * and expires. Sixty seconds is enough to open it and is short enough that a leaked one is useless.
 *
 * Access is decided by the storage policies — the student's own folder, or migration 014's
 * "application reviewers read documents" for staff. A refusal here is a real refusal, so the caller
 * is told rather than shown a broken link.
 */
export async function signedDocumentUrl(path: string, seconds = 60): Promise<string> {
  const { data, error } = await supabase.storage.from(BUCKET).createSignedUrl(path, seconds)
  if (error) throw new Error(error.message)
  if (!data?.signedUrl) throw new Error('That document could not be opened.')
  return data.signedUrl
}

/** Opens a signed URL in a new tab. Used by the student and the admin detail page alike. */
export async function openDocument(path: string): Promise<void> {
  const url = await signedDocumentUrl(path)
  window.open(url, '_blank', 'noopener,noreferrer')
}

/**
 * Deletes one object the caller owns, quietly.
 *
 * Only ever called on a path this session uploaded, and ownPaths() is applied again here because a
 * caller that ever assembled the list from somewhere else must not be able to delete another
 * student's documents. Failing to tidy up an orphaned object is harmless; deleting somebody else's
 * is not, so the failure is swallowed rather than surfaced.
 */
export async function discardOwnObjects(userId: string, paths: string[]): Promise<void> {
  const mine = ownPaths(userId, paths)
  if (mine.length === 0) return
  try {
    await supabase.storage.from(BUCKET).remove(mine)
  } catch {
    // Best effort. The superseded object simply stays in the bucket unreferenced.
  }
}
