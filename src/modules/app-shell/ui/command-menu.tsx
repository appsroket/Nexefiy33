'use client'

import { Search } from 'lucide-react'
import { useRouter } from 'next/navigation'
import { useEffect, useState } from 'react'

import { Button } from '@/components/ui/button'
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from '@/components/ui/command'
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Kbd, KbdGroup } from '@/components/ui/kbd'

import { NAVIGATION } from '../domain/navigation'
import { NAV_ICONS } from './nav-icons'

/** Keyboard-first navigation: Ctrl+K (⌘K on Mac) opens a searchable list of every section. */
export function CommandMenu() {
  const router = useRouter()
  const [open, setOpen] = useState(false)

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === 'k' && (event.metaKey || event.ctrlKey) && !event.altKey) {
        event.preventDefault()
        setOpen((value) => !value)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [])

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
        aria-keyshortcuts="Control+K Meta+K"
        className="w-9 justify-center px-0 text-muted-foreground sm:w-56 sm:justify-start sm:px-2.5"
      >
        <Search aria-hidden="true" />
        <span className="hidden sm:inline">Go to…</span>
        <span className="sr-only sm:hidden">Go to a page</span>
        <KbdGroup className="ml-auto hidden sm:inline-flex" aria-hidden="true">
          <Kbd>Ctrl</Kbd>
          <Kbd>K</Kbd>
        </KbdGroup>
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="top-1/3 translate-y-0 overflow-hidden p-0 sm:max-w-lg" showCloseButton={false}>
          <DialogHeader className="sr-only">
            <DialogTitle>Go to a page</DialogTitle>
            <DialogDescription>Type to filter, use the arrow keys to choose, and press Enter to open.</DialogDescription>
          </DialogHeader>
          <Command>
            <CommandInput placeholder="Search pages…" aria-label="Search pages" />
            <CommandList>
              <CommandEmpty>No matching pages.</CommandEmpty>
              {NAVIGATION.map((section) => (
                <CommandGroup key={section.title} heading={section.title}>
                  {section.items.map((item) => {
                    const Icon = NAV_ICONS[item.icon]
                    return (
                      <CommandItem
                        key={item.href}
                        value={item.title}
                        keywords={[...item.keywords]}
                        onSelect={() => {
                          setOpen(false)
                          router.push(item.href)
                        }}
                      >
                        <Icon aria-hidden="true" />
                        <span>{item.title}</span>
                        {item.availability === 'planned' ? (
                          <span className="ml-auto text-xs text-muted-foreground">Coming soon</span>
                        ) : null}
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              ))}
            </CommandList>
          </Command>
        </DialogContent>
      </Dialog>
    </>
  )
}
