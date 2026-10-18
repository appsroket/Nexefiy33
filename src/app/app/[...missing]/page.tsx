import { notFound } from 'next/navigation'

// Any unknown path renders the in-shell 404 (app/app/not-found.tsx).
export default function MissingPage() {
  notFound()
}
