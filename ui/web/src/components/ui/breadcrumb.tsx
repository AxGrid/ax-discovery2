import { forwardRef } from 'react'
import type { ComponentProps, HTMLAttributes, ReactNode } from 'react'
import { ChevronRight, MoreHorizontal, Slash } from 'lucide-react'
import { Slot } from '@radix-ui/react-slot'
import { cn } from './utils'

export const Breadcrumb = forwardRef<
  HTMLElement,
  ComponentProps<'nav'> & { separator?: ReactNode }
>(({ ...props }, ref) => <nav ref={ref} aria-label="breadcrumb" {...props} />)
Breadcrumb.displayName = 'Breadcrumb'

export const BreadcrumbList = forwardRef<HTMLOListElement, ComponentProps<'ol'>>(
  ({ className, ...props }, ref) => (
    <ol
      ref={ref}
      className={cn(
        'flex flex-wrap items-center gap-1.5 text-sm text-fg-muted break-words sm:gap-2',
        className
      )}
      {...props}
    />
  )
)
BreadcrumbList.displayName = 'BreadcrumbList'

export const BreadcrumbItem = forwardRef<HTMLLIElement, ComponentProps<'li'>>(
  ({ className, ...props }, ref) => (
    <li ref={ref} className={cn('inline-flex items-center gap-1.5', className)} {...props} />
  )
)
BreadcrumbItem.displayName = 'BreadcrumbItem'

export const BreadcrumbLink = forwardRef<
  HTMLAnchorElement,
  ComponentProps<'a'> & { asChild?: boolean }
>(({ asChild, className, ...props }, ref) => {
  const Comp = asChild ? Slot : 'a'
  return (
    <Comp
      ref={ref}
      className={cn('hover:text-fg transition-colors rounded-[var(--radius-xs)] focus-visible:outline-none focus-visible:[box-shadow:0_0_0_2px_var(--bg),0_0_0_3px_var(--ring)]', className)}
      {...props}
    />
  )
})
BreadcrumbLink.displayName = 'BreadcrumbLink'

export const BreadcrumbPage = forwardRef<HTMLSpanElement, ComponentProps<'span'>>(
  ({ className, ...props }, ref) => (
    <span
      ref={ref}
      role="link"
      aria-disabled="true"
      aria-current="page"
      className={cn('font-medium text-fg', className)}
      {...props}
    />
  )
)
BreadcrumbPage.displayName = 'BreadcrumbPage'

export function BreadcrumbSeparator({
  children,
  className,
  ...props
}: HTMLAttributes<HTMLLIElement>) {
  return (
    <li
      role="presentation"
      aria-hidden="true"
      className={cn('text-fg-subtle [&_svg]:size-3.5', className)}
      {...props}
    >
      {children ?? <ChevronRight />}
    </li>
  )
}

export function BreadcrumbSeparatorSlash({
  className,
  ...props
}: HTMLAttributes<HTMLLIElement>) {
  return (
    <li
      role="presentation"
      aria-hidden="true"
      className={cn('text-fg-subtle [&_svg]:size-3', className)}
      {...props}
    >
      <Slash />
    </li>
  )
}

export function BreadcrumbEllipsis({
  className,
  ...props
}: HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      role="presentation"
      aria-hidden="true"
      className={cn('flex size-9 items-center justify-center text-fg-muted', className)}
      {...props}
    >
      <MoreHorizontal className="size-4" />
      <span className="sr-only">More</span>
    </span>
  )
}
