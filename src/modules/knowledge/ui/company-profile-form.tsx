'use client'

// Company profile, operating hours and brand voice. Admins and owners only;
// the database enforces that and validates the stored JSON.

import { useState } from 'react'

import { ActionForm, FieldErrors, FormMessage, SubmitButton } from '@/components/forms/action-form'
import { SelectField, TextAreaField, TextField } from '@/components/forms/text-field'
import { FieldGroup, FieldLegend, FieldSet } from '@/components/ui/field'

import { FORMALITY_LEVELS, TEAM_SIZES, WEEKDAY_LABELS, WEEKDAYS, type CompanyProfile, type Weekday } from '../domain/company-profile'
import { updateCompanyProfile } from '../server/actions'

const DEFAULT_RANGE = { open: '09:00', close: '17:00' }

function DayRow({ day, initial }: { day: Weekday; initial: { open: string; close: string } | null }) {
  const [closed, setClosed] = useState(initial === null)
  const range = initial ?? DEFAULT_RANGE
  return (
    <div className="grid grid-cols-[6.5rem_1fr] items-center gap-x-3 gap-y-1 sm:grid-cols-[7rem_auto_auto_auto]">
      <span className="text-sm font-medium">{WEEKDAY_LABELS[day]}</span>
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" name={`hours_${day}_closed`} checked={closed} onChange={(event) => setClosed(event.target.checked)} className="size-4" />
        Closed
      </label>
      {closed ? (
        <span className="col-span-2 text-sm text-muted-foreground sm:col-span-2" />
      ) : (
        <div className="col-span-2 flex items-center gap-2 sm:col-span-2">
          <input
            type="time"
            name={`hours_${day}_open`}
            defaultValue={range.open}
            aria-label={`${WEEKDAY_LABELS[day]} opening time`}
            className="h-9 rounded-lg border border-input bg-transparent px-2 text-sm"
          />
          <span aria-hidden="true">–</span>
          <input
            type="time"
            name={`hours_${day}_close`}
            defaultValue={range.close === '24:00' ? '23:59' : range.close}
            aria-label={`${WEEKDAY_LABELS[day]} closing time`}
            className="h-9 rounded-lg border border-input bg-transparent px-2 text-sm"
          />
        </div>
      )}
      <div className="col-span-full">
        <FieldErrors name={`hours_${day}_open`} />
      </div>
    </div>
  )
}

export function CompanyProfileForm({
  organizationId,
  profile,
  timeZones,
}: {
  organizationId: string
  profile: CompanyProfile | null
  timeZones: readonly string[]
}) {
  const settings = profile?.settings ?? {}
  const weekly = settings.operatingHours?.weekly
  const [hoursEnabled, setHoursEnabled] = useState(Boolean(weekly))
  const timezone = profile?.timezone ?? 'UTC'
  const zones = timeZones.includes(timezone) ? timeZones : [timezone, ...timeZones]

  return (
    <ActionForm action={updateCompanyProfile} aria-label="Company profile" className="flex max-w-3xl flex-col gap-6">
      <FormMessage />
      <input type="hidden" name="organizationId" value={organizationId} />

      <FieldSet>
        <FieldLegend>Company</FieldLegend>
        <FieldGroup>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField name="legalName" label="Legal company name" autoComplete="organization" maxLength={200} defaultValue={profile?.legalName ?? ''} />
            <TextField name="industry" label="Industry" maxLength={100} defaultValue={profile?.industry ?? ''} placeholder="Residential roofing" />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextField name="website" label="Website" inputMode="url" autoComplete="url" placeholder="example.com" maxLength={500} defaultValue={profile?.website ?? ''} />
            <TextField name="headquarters" label="Headquarters" maxLength={200} defaultValue={settings.profile?.headquarters ?? ''} />
          </div>
          <div className="grid gap-4 sm:grid-cols-3">
            <TextField name="foundedYear" label="Founded" inputMode="numeric" maxLength={4} defaultValue={settings.profile?.foundedYear?.toString() ?? ''} />
            <SelectField
              name="teamSize"
              label="Team size"
              defaultValue={settings.profile?.teamSize ?? ''}
              options={[{ value: '', label: 'Not set' }, ...TEAM_SIZES.map((size) => ({ value: size, label: size === '1' ? 'Just me' : `${size} people` }))]}
            />
            <TextField name="languages" label="Languages served" description="Separate with commas." maxLength={600} defaultValue={settings.profile?.languages?.join(', ') ?? ''} />
          </div>
          <TextField name="serviceArea" label="Service area" maxLength={500} placeholder="Greater Lisbon and Setúbal" defaultValue={settings.profile?.serviceArea ?? ''} />
          <TextAreaField name="description" label="What your company does" rows={4} maxLength={5000} defaultValue={profile?.description ?? ''} />
        </FieldGroup>
      </FieldSet>

      <FieldSet>
        <FieldLegend>Operating hours</FieldLegend>
        <FieldGroup>
          <SelectField name="timezone" label="Time zone" defaultValue={timezone} options={zones.map((zone) => ({ value: zone, label: zone.replace(/_/g, ' ') }))} />
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" name="hoursEnabled" checked={hoursEnabled} onChange={(event) => setHoursEnabled(event.target.checked)} className="size-4" />
            Set weekly opening hours
          </label>
          {hoursEnabled ? (
            <div className="flex flex-col gap-3">
              {WEEKDAYS.map((day) => {
                const ranges = weekly?.[day]
                const initial = weekly ? (ranges?.[0] ?? null) : day === 'sat' || day === 'sun' ? null : DEFAULT_RANGE
                return <DayRow key={day} day={day} initial={initial} />
              })}
              <TextField name="hoursNotes" label="Notes (optional)" maxLength={1000} placeholder="Closed on public holidays" defaultValue={settings.operatingHours?.notes ?? ''} />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">Without hours, AI employees won’t promise when someone is available.</p>
          )}
        </FieldGroup>
      </FieldSet>

      <FieldSet>
        <FieldLegend>Brand voice</FieldLegend>
        <FieldGroup>
          <TextAreaField
            name="brandVoice"
            label="How you sound"
            description="A few sentences on how your company writes and speaks."
            rows={3}
            maxLength={2000}
            defaultValue={profile?.brandVoice ?? ''}
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <SelectField
              name="formality"
              label="Formality"
              defaultValue={settings.brandVoice?.formality ?? ''}
              options={[{ value: '', label: 'Not set' }, ...FORMALITY_LEVELS.map((level) => ({ value: level, label: level[0]!.toUpperCase() + level.slice(1) }))]}
            />
            <TextField name="tone" label="Tone words" description="Separate with commas, e.g. warm, direct." maxLength={500} defaultValue={settings.brandVoice?.tone?.join(', ') ?? ''} />
          </div>
          <div className="grid gap-4 sm:grid-cols-2">
            <TextAreaField name="preferredPhrases" label="Phrases to use" description="One per line." rows={3} defaultValue={settings.brandVoice?.preferredPhrases?.join('\n') ?? ''} />
            <TextAreaField name="avoidPhrases" label="Phrases to avoid" description="One per line." rows={3} defaultValue={settings.brandVoice?.avoidPhrases?.join('\n') ?? ''} />
          </div>
        </FieldGroup>
      </FieldSet>

      <div>
        <SubmitButton>Save company profile</SubmitButton>
      </div>
    </ActionForm>
  )
}
