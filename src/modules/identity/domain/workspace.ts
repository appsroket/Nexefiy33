// Workspace (organization) limits and helpers. Free of Zod so client
// components can import it; validation schemas are in schemas.ts.

/** Same pattern as the organizations.slug check constraint. */
export const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,46}[a-z0-9]$/
export const SLUG_MAX_LENGTH = 48
export const WORKSPACE_NAME_MAX_LENGTH = 120

/** A workspace address suggestion from its name: "Acme Café Ltd." → "acme-cafe-ltd". */
export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_MAX_LENGTH)
    .replace(/-+$/g, '')
  if (base.length >= 3) return base
  return base ? `${base}-workspace` : ''
}

/** Typed confirmation for deleting a workspace: the user must type its address. */
export function deleteConfirmationMatches(typed: unknown, slug: string): boolean {
  return typeof typed === 'string' && typed.trim().toLowerCase() === slug
}
