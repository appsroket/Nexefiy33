// Scheduled triggers: standard five-field cron expressions (minute, hour,
// day of month, month, day of week; numbers, "*", ranges, lists and steps —
// no names or special strings) evaluated in an IANA time zone. Pure and
// Zod-free; uses only Intl for time-zone arithmetic.

export interface CronSchedule {
  minutes: number[]
  hours: number[]
  daysOfMonth: Set<number>
  months: Set<number>
  daysOfWeek: Set<number>
  /** Whether day of month / day of week were restricted ("*" isn't). */
  domRestricted: boolean
  dowRestricted: boolean
}

const FIELDS = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day of month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12 },
  { name: 'day of week', min: 0, max: 7 },
] as const

function parseField(text: string, field: (typeof FIELDS)[number]): number[] | string {
  const values = new Set<number>()
  for (const part of text.split(',')) {
    const match = part.match(/^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/)
    if (!match) return `The ${field.name} field “${part}” isn’t valid.`
    const step = match[4] ? Number(match[4]) : 1
    let from: number = field.min
    let to: number = field.max
    if (match[1] !== '*') {
      from = Number(match[2])
      to = match[3] !== undefined ? Number(match[3]) : match[4] ? field.max : from
    }
    if (from < field.min || to > field.max || from > to || step < 1) return `The ${field.name} field “${part}” is out of range (${field.min}–${field.max}).`
    for (let value = from; value <= to; value += step) values.add(value)
  }
  return [...values].sort((a, b) => a - b)
}

export function parseCron(expression: string): CronSchedule | string {
  const parts = expression.trim().split(/\s+/)
  if (parts.length !== 5) return 'A schedule needs five fields: minute, hour, day of month, month, day of week (for example “0 9 * * 1-5”).'
  const parsed: number[][] = []
  for (let index = 0; index < 5; index++) {
    const result = parseField(parts[index]!, FIELDS[index]!)
    if (typeof result === 'string') return result
    parsed.push(result)
  }
  const minutes = parsed[0]!
  // Runs at most every 5 minutes: the dispatcher sweeps once a minute and runs aren't free.
  if (minutes.length > 12 || minutes.some((value, index) => index > 0 && value - minutes[index - 1]! < 5) || (minutes.length > 1 && 60 - minutes.at(-1)! + minutes[0]! < 5)) {
    return 'A schedule can run at most every 5 minutes.'
  }
  return {
    minutes,
    hours: parsed[1]!,
    daysOfMonth: new Set(parsed[2]),
    months: new Set(parsed[3]),
    daysOfWeek: new Set(parsed[4]!.map((day) => day % 7)),
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  }
}

export function isValidTimeZone(timeZone: string): boolean {
  if (!timeZone || timeZone.length > 64) return false
  try {
    new Intl.DateTimeFormat('en-US', { timeZone })
    return true
  } catch {
    return false
  }
}

interface LocalParts {
  year: number
  month: number
  day: number
  hour: number
  minute: number
}

const formatters = new Map<string, Intl.DateTimeFormat>()

function localParts(date: Date, timeZone: string): LocalParts {
  let formatter = formatters.get(timeZone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' })
    formatters.set(timeZone, formatter)
  }
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]))
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour) % 24, minute: Number(parts.minute) }
}

/** The UTC instant of a wall-clock time in a time zone (the earlier one when the clock repeats; skipped times move forward). */
function zonedTime(parts: LocalParts, timeZone: string): Date {
  const wall = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute)
  let guess = wall
  for (let index = 0; index < 3; index++) {
    const seen = localParts(new Date(guess), timeZone)
    const seenWall = Date.UTC(seen.year, seen.month - 1, seen.day, seen.hour, seen.minute)
    const diff = wall - seenWall
    if (diff === 0) break
    guess += diff
  }
  return new Date(guess)
}

/** The first time strictly after `after` that matches the schedule, or null within ~4 years. */
export function nextRun(schedule: CronSchedule, timeZone: string, after: Date): Date | null {
  const start = localParts(new Date(after.getTime() + 60_000), timeZone)
  const day = new Date(Date.UTC(start.year, start.month - 1, start.day))
  for (let offset = 0; offset < 1500; offset++, day.setUTCDate(day.getUTCDate() + 1)) {
    const month = day.getUTCMonth() + 1
    if (!schedule.months.has(month)) continue
    const dom = schedule.daysOfMonth.has(day.getUTCDate())
    const dow = schedule.daysOfWeek.has(day.getUTCDay())
    const dayMatches = schedule.domRestricted && schedule.dowRestricted ? dom || dow : schedule.domRestricted ? dom : schedule.dowRestricted ? dow : true
    if (!dayMatches) continue
    for (const hour of schedule.hours) {
      for (const minute of schedule.minutes) {
        const candidate = zonedTime({ year: day.getUTCFullYear(), month, day: day.getUTCDate(), hour, minute }, timeZone)
        if (candidate.getTime() > after.getTime()) return candidate
      }
    }
  }
  return null
}

/** Validates a schedule and returns its next run, or the reason it is invalid. */
export function checkSchedule(cron: string, timeZone: string, now: Date): { ok: true; next: Date } | { ok: false; message: string } {
  if (!isValidTimeZone(timeZone)) return { ok: false, message: `“${timeZone}” isn’t a time zone. Use a name like Europe/Paris or UTC.` }
  const schedule = parseCron(cron)
  if (typeof schedule === 'string') return { ok: false, message: schedule }
  const next = nextRun(schedule, timeZone, now)
  if (!next) return { ok: false, message: 'This schedule never runs.' }
  return { ok: true, next }
}
