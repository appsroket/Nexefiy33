// Frame for the sign-in, sign-up, password and invitation pages.

import Link from 'next/link'
import type { ReactNode } from 'react'

export function AuthCard({
  title,
  description,
  children,
  footer,
}: {
  title: string
  description?: ReactNode
  children: ReactNode
  footer?: ReactNode
}) {
  return (
    <div className="mx-auto flex w-full max-w-6xl justify-center px-4 py-12 sm:px-6 sm:py-20">
      <div className="flex w-full max-w-md flex-col gap-6 rounded-2xl border bg-card p-6 text-card-foreground shadow-sm sm:p-8">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
          {description ? <p className="text-pretty text-muted-foreground">{description}</p> : null}
        </div>
        {children}
        {footer ? <div className="border-t pt-4 text-sm text-muted-foreground">{footer}</div> : null}
      </div>
    </div>
  )
}

export function InlineLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} className="font-medium text-primary underline-offset-4 hover:underline">
      {children}
    </Link>
  )
}
