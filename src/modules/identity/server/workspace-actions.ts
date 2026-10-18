'use server'

// Creating, editing, leaving and deleting workspaces.
//
// Every action re-verifies the session with Supabase Auth and runs its query
// under the user's own session, so Row Level Security and the database
// triggers decide what is allowed. A query that changes no rows means the
// user wasn't allowed to change it. Workspace ids sent by the browser are
// validated but never trusted.

import { revalidatePath } from 'next/cache'
import { redirect } from 'next/navigation'
import { z } from 'zod'

import { actionError, actionSuccess, type ActionState } from '@/lib/forms/action-state'
import { parseFormData } from '@/lib/forms/parse-form'
import { createUserClient } from '@/lib/supabase/server'
import { forgetWorkspace, rememberWorkspace } from '@/modules/app-shell/server/workspace-cookie'

import { companyDetailsSchema, workspaceSchema } from '../domain/schemas'
import { deleteConfirmationMatches } from '../domain/workspace'
import { getVerifiedUser, SESSION_ENDED_MESSAGE } from './session'

const FIX_FIELDS = 'Please correct the highlighted fields.'
const NOT_ALLOWED = 'You don’t have permission to do that in this workspace.'
const SLUG_TAKEN = 'That address is already taken. Try another one.'

function readOrganizationId(formData: FormData): string | null {
  const parsed = z.uuid().safeParse(formData.get('organizationId'))
  return parsed.success ? parsed.data : null
}

function logFailure(action: string, error: { code?: string } | null) {
  console.error(`[identity] ${action} failed`, { code: error?.code ?? 'unknown' })
}

export async function createWorkspace(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const parsed = parseFormData(workspaceSchema, formData)
  if (!parsed.ok) return parsed.state

  const supabase = await createUserClient()
  if (!(await getVerifiedUser(supabase))) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')

  const { data, error } = await supabase.rpc('create_organization', { p_name: parsed.data.name, p_slug: parsed.data.slug })
  if (error) {
    if (error.code === '23505') return actionError(FIX_FIELDS, { slug: [SLUG_TAKEN] })
    logFailure('workspace creation', error)
    return actionError('We couldn’t create the workspace. Please try again.')
  }

  await rememberWorkspace(data.id)
  revalidatePath('/app', 'layout')
  redirect('/app')
}

export async function updateWorkspace(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const organizationId = readOrganizationId(formData)
  if (!organizationId) return actionError(NOT_ALLOWED)
  const parsed = parseFormData(workspaceSchema, formData)
  if (!parsed.ok) return parsed.state

  const supabase = await createUserClient()
  if (!(await getVerifiedUser(supabase))) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')

  const { data, error } = await supabase
    .from('organizations')
    .update({ name: parsed.data.name, slug: parsed.data.slug })
    .eq('id', organizationId)
    .select('id')
  if (error) {
    if (error.code === '23505') return actionError(FIX_FIELDS, { slug: [SLUG_TAKEN] })
    logFailure('workspace update', error)
    return actionError('We couldn’t save the workspace. Please try again.')
  }
  if (data.length === 0) return actionError(NOT_ALLOWED)

  revalidatePath('/app', 'layout')
  return actionSuccess('Workspace saved.')
}

export async function updateCompanyDetails(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const organizationId = readOrganizationId(formData)
  if (!organizationId) return actionError(NOT_ALLOWED)
  const parsed = parseFormData(companyDetailsSchema, formData)
  if (!parsed.ok) return parsed.state

  const supabase = await createUserClient()
  if (!(await getVerifiedUser(supabase))) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')

  const details = parsed.data
  const { data, error } = await supabase
    .from('company_settings')
    .update({
      legal_name: details.legalName,
      industry: details.industry,
      website: details.website,
      description: details.description,
      timezone: details.timezone,
    })
    .eq('organization_id', organizationId)
    .select('organization_id')
  if (error) {
    logFailure('company details update', error)
    return actionError('We couldn’t save the company details. Please try again.')
  }
  if (data.length === 0) return actionError(NOT_ALLOWED)

  revalidatePath('/app', 'layout')
  return actionSuccess('Company details saved.')
}

/** Leaves a workspace. The caller navigates away on success. */
export async function leaveWorkspace(organizationId: string): Promise<ActionState> {
  const id = z.uuid().safeParse(organizationId)
  if (!id.success) return actionError(NOT_ALLOWED)

  const supabase = await createUserClient()
  const user = await getVerifiedUser(supabase)
  if (!user) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')

  const { data, error } = await supabase
    .from('organization_members')
    .delete()
    .eq('organization_id', id.data)
    .eq('user_id', user.id)
    .select('user_id')
  if (error) {
    if (error.code === '23514') {
      return actionError('You’re the only owner. Make someone else an owner first, or delete the workspace.')
    }
    logFailure('leaving a workspace', error)
    return actionError('We couldn’t remove you from the workspace. Please try again.')
  }
  if (data.length === 0) return actionError('You’re not a member of this workspace.')

  await forgetWorkspace()
  revalidatePath('/app', 'layout')
  return actionSuccess()
}

/** Deletes a workspace and everything in it. Owners only; the address must be typed to confirm. */
export async function deleteWorkspace(_previous: ActionState, formData: FormData): Promise<ActionState> {
  const organizationId = readOrganizationId(formData)
  if (!organizationId) return actionError(NOT_ALLOWED)

  const supabase = await createUserClient()
  if (!(await getVerifiedUser(supabase))) return actionError(SESSION_ENDED_MESSAGE, undefined, 'session_ended')

  const { data: workspace, error: readError } = await supabase
    .from('organizations')
    .select('slug')
    .eq('id', organizationId)
    .maybeSingle()
  if (readError) {
    logFailure('reading a workspace to delete', readError)
    return actionError('We couldn’t delete the workspace. Please try again.')
  }
  if (!workspace) return actionError(NOT_ALLOWED)
  if (!deleteConfirmationMatches(formData.get('confirmation'), workspace.slug)) {
    return actionError(FIX_FIELDS, { confirmation: [`Type ${workspace.slug} to confirm.`] })
  }

  const { data, error } = await supabase.from('organizations').delete().eq('id', organizationId).select('id')
  if (error) {
    logFailure('workspace deletion', error)
    return actionError('We couldn’t delete the workspace. Please try again.')
  }
  if (data.length === 0) return actionError('Only an owner can delete this workspace.')

  await forgetWorkspace()
  revalidatePath('/app', 'layout')
  redirect('/app')
}
