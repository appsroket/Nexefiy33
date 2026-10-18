'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import type { ReactNode } from 'react'

import {
  Sidebar,
  SidebarContent,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuBadge,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from '@/components/ui/sidebar'

import { NAVIGATION, isNavItemActive } from '../domain/navigation'
import { NAV_ICONS } from './nav-icons'

/**
 * Primary navigation. Collapses to icons on desktop (Ctrl/⌘+B) and becomes a
 * slide-over sheet on small screens, closing after each navigation.
 */
export function AppSidebar({ header }: { header: ReactNode }) {
  const pathname = usePathname()
  const { isMobile, setOpenMobile } = useSidebar()

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>{header}</SidebarHeader>
      <SidebarContent>
        <nav aria-label="Main">
          {NAVIGATION.map((section) => (
            <SidebarGroup key={section.title}>
              <SidebarGroupLabel>{section.title}</SidebarGroupLabel>
              <SidebarGroupContent>
                <SidebarMenu>
                  {section.items.map((item) => {
                    const Icon = NAV_ICONS[item.icon]
                    const active = isNavItemActive(item, pathname)
                    const planned = item.availability === 'planned'
                    return (
                      <SidebarMenuItem key={item.href}>
                        <SidebarMenuButton asChild isActive={active} tooltip={item.title}>
                          <Link
                            href={item.href}
                            aria-current={active ? 'page' : undefined}
                            onClick={() => {
                              if (isMobile) setOpenMobile(false)
                            }}
                          >
                            <Icon aria-hidden="true" />
                            <span>{item.title}</span>
                            {planned ? <span className="sr-only"> (coming soon)</span> : null}
                          </Link>
                        </SidebarMenuButton>
                        {planned ? (
                          <SidebarMenuBadge aria-hidden="true" className="text-[0.65rem] font-normal text-muted-foreground">
                            Soon
                          </SidebarMenuBadge>
                        ) : null}
                      </SidebarMenuItem>
                    )
                  })}
                </SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          ))}
        </nav>
      </SidebarContent>
      <SidebarRail />
    </Sidebar>
  )
}
