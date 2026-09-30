import { supabase } from './supabase'
// Uploads into the caller's own folder so storage policies (own-folder-only) are satisfied.
export async function uploadVerificationFile(userId: string, kind: 'certificate' | 'id' | 'passport', file: File) {
  const ext = file.name.split('.').pop() || 'bin'
  const path = `${userId}/${kind}-${Date.now()}.${ext}`
  const { error } = await supabase.storage.from('verification-documents').upload(path, file, { upsert: false })
  if (error) throw error
  return path
}
