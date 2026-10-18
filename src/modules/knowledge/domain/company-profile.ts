// Company profile, operating hours and brand voice, stored in
// company_settings (columns plus the `settings` JSON, validated by
// private.company_settings_is_valid v1). Pure types and rules; no Zod, because
// client components import these.

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
export type Weekday = (typeof WEEKDAYS)[number]

export const WEEKDAY_LABELS: Record<Weekday, string> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
}

export const TEAM_SIZES = ['1', '2-10', '11-50', '51-200', '201-1000', '1000+'] as const
export type TeamSize = (typeof TEAM_SIZES)[number]

export const FORMALITY_LEVELS = ['casual', 'neutral', 'formal'] as const
export type Formality = (typeof FORMALITY_LEVELS)[number]

export interface TimeRange {
  open: string
  close: string
}

export type WeeklyHours = Partial<Record<Weekday, TimeRange[]>>

export interface CompanySettingsJson {
  schemaVersion?: 1
  profile?: {
    headquarters?: string
    foundedYear?: number
    teamSize?: TeamSize
    serviceArea?: string
    languages?: string[]
  }
  operatingHours?: { weekly: WeeklyHours; notes?: string }
  brandVoice?: {
    formality?: Formality
    tone?: string[]
    preferredPhrases?: string[]
    avoidPhrases?: string[]
  }
}

export interface CompanyProfile {
  legalName: string | null
  industry: string | null
  description: string | null
  website: string | null
  timezone: string
  brandVoice: string | null
  settings: CompanySettingsJson
}

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/
const CLOSE_TIME = /^(([01]\d|2[0-3]):[0-5]\d|24:00)$/

export function minutesOf(time: string): number {
  const [hours, minutes] = time.split(':').map(Number)
  return hours! * 60 + minutes!
}

/** Problems with one day's ranges: bad format, close before open, overlaps. */
export function timeRangeProblems(ranges: readonly TimeRange[]): string[] {
  const problems: string[] = []
  const sorted = [...ranges].sort((a, b) => a.open.localeCompare(b.open))
  for (const range of sorted) {
    if (!TIME.test(range.open) || !CLOSE_TIME.test(range.close)) problems.push('Use 24-hour times such as 09:00 and 17:30.')
    else if (minutesOf(range.close) <= minutesOf(range.open)) problems.push('Closing time must be after opening time.')
  }
  for (let index = 1; index < sorted.length; index += 1) {
    if (minutesOf(sorted[index]!.open) < minutesOf(sorted[index - 1]!.close)) problems.push('Opening hours on the same day must not overlap.')
  }
  return [...new Set(problems)]
}

/** The weekday and minutes since midnight at `date` in an IANA time zone. */
export function localWeekdayAndMinutes(date: Date, timeZone: string): { weekday: Weekday; minutes: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(date)
  const get = (type: string) => parts.find((part) => part.type === type)?.value ?? ''
  const weekday = get('weekday').toLowerCase().slice(0, 3) as Weekday
  return { weekday, minutes: Number(get('hour')) * 60 + Number(get('minute')) }
}

export type OpenState = { known: false } | { known: true; open: boolean; weekday: Weekday; localTime: string }

/**
 * Whether the business is open at `date`, in its own time zone. "Unknown"
 * when no weekly hours are configured — employees must not guess.
 */
export function openStateAt(hours: WeeklyHours | undefined, timeZone: string, date: Date): OpenState {
  if (!hours || !Object.keys(hours).length) return { known: false }
  const { weekday, minutes } = localWeekdayAndMinutes(date, timeZone)
  const ranges = hours[weekday] ?? []
  const open = ranges.some((range) => minutes >= minutesOf(range.open) && minutes < minutesOf(range.close))
  const localTime = `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`
  return { known: true, open, weekday, localTime }
}

/** "Monday: 09:00–17:00" lines; days without ranges read "closed". */
export function describeWeeklyHours(hours: WeeklyHours | undefined): string[] {
  if (!hours || !Object.keys(hours).length) return []
  return WEEKDAYS.map((day) => {
    const ranges = hours[day] ?? []
    return `${WEEKDAY_LABELS[day]}: ${ranges.length ? ranges.map((range) => `${range.open}–${range.close}`).join(', ') : 'closed'}`
  })
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}
