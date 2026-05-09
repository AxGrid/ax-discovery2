import { forwardRef } from 'react'
import type { ComponentProps } from 'react'
import { ChevronLeft, ChevronRight, MoreHorizontal } from 'lucide-react'
import { cn } from './utils'
import { buttonVariants } from './button'

/**
 * Pagination — composable primitives. For the smart "1 … 4 5 6 … 20"
 * layout, use `paginationRange(currentPage, totalPages, siblings)` to get
 * the array of page numbers + 'ellipsis' markers and map over it.
 */
export const Pagination = ({ className, ...props }: ComponentProps<'nav'>) => (
  <nav
    role="navigation"
    aria-label="pagination"
    className={cn('mx-auto flex w-full justify-center', className)}
    {...props}
  />
)
Pagination.displayName = 'Pagination'

export const PaginationContent = forwardRef<HTMLUListElement, ComponentProps<'ul'>>(
  ({ className, ...props }, ref) => (
    <ul ref={ref} className={cn('flex flex-row items-center gap-1', className)} {...props} />
  )
)
PaginationContent.displayName = 'PaginationContent'

export const PaginationItem = forwardRef<HTMLLIElement, ComponentProps<'li'>>(
  ({ className, ...props }, ref) => <li ref={ref} className={cn('', className)} {...props} />
)
PaginationItem.displayName = 'PaginationItem'

type PaginationLinkProps = {
  isActive?: boolean
  size?: 'sm' | 'md' | 'icon'
} & Pick<React.ComponentProps<'button'>, 'onClick' | 'disabled' | 'aria-label' | 'type'>
  & ComponentProps<'a'>

export const PaginationLink = ({
  className,
  isActive,
  size = 'icon',
  ...props
}: PaginationLinkProps) => (
  <a
    aria-current={isActive ? 'page' : undefined}
    className={cn(
      buttonVariants({
        variant: isActive ? 'primary' : 'ghost',
        size,
      }),
      'cursor-pointer select-none',
      isActive && 'pointer-events-auto',
      className
    )}
    {...props}
  />
)
PaginationLink.displayName = 'PaginationLink'

export const PaginationPrevious = ({
  className,
  label = 'Previous',
  showLabel = true,
  ...props
}: ComponentProps<typeof PaginationLink> & { label?: string; showLabel?: boolean }) => (
  <PaginationLink
    aria-label="Go to previous page"
    size={showLabel ? 'sm' : 'icon'}
    className={cn('gap-1.5 px-2.5', className)}
    {...props}
  >
    <ChevronLeft className="size-4" />
    {showLabel ? <span>{label}</span> : null}
  </PaginationLink>
)
PaginationPrevious.displayName = 'PaginationPrevious'

export const PaginationNext = ({
  className,
  label = 'Next',
  showLabel = true,
  ...props
}: ComponentProps<typeof PaginationLink> & { label?: string; showLabel?: boolean }) => (
  <PaginationLink
    aria-label="Go to next page"
    size={showLabel ? 'sm' : 'icon'}
    className={cn('gap-1.5 px-2.5', className)}
    {...props}
  >
    {showLabel ? <span>{label}</span> : null}
    <ChevronRight className="size-4" />
  </PaginationLink>
)
PaginationNext.displayName = 'PaginationNext'

export const PaginationEllipsis = ({
  className,
  ...props
}: ComponentProps<'span'>) => (
  <span
    aria-hidden
    className={cn('flex h-9 w-9 items-center justify-center text-fg-subtle', className)}
    {...props}
  >
    <MoreHorizontal className="size-4" />
    <span className="sr-only">More pages</span>
  </span>
)
PaginationEllipsis.displayName = 'PaginationEllipsis'

/**
 * Compute a smart pagination range with ellipsis markers. Always shows
 * the first and last pages, and `siblings` neighbors around the current page.
 *
 * paginationRange(7, 20, 1) => [1, 'ellipsis', 6, 7, 8, 'ellipsis', 20]
 * paginationRange(2, 20, 1) => [1, 2, 3, 4, 5, 'ellipsis', 20]
 * paginationRange(19, 20, 1) => [1, 'ellipsis', 16, 17, 18, 19, 20]
 */
export function paginationRange(
  current: number,
  total: number,
  siblings = 1
): (number | 'ellipsis')[] {
  if (total <= 0) return []
  const totalNumbers = siblings * 2 + 5
  if (total <= totalNumbers) {
    return Array.from({ length: total }, (_, i) => i + 1)
  }

  const leftSibling  = Math.max(current - siblings, 1)
  const rightSibling = Math.min(current + siblings, total)
  const showLeftEllipsis  = leftSibling  > 2
  const showRightEllipsis = rightSibling < total - 1

  if (!showLeftEllipsis && showRightEllipsis) {
    const leftCount = 3 + 2 * siblings
    return [
      ...Array.from({ length: leftCount }, (_, i) => i + 1),
      'ellipsis',
      total,
    ]
  }
  if (showLeftEllipsis && !showRightEllipsis) {
    const rightCount = 3 + 2 * siblings
    return [
      1,
      'ellipsis',
      ...Array.from({ length: rightCount }, (_, i) => total - rightCount + 1 + i),
    ]
  }
  return [
    1,
    'ellipsis',
    ...Array.from({ length: rightSibling - leftSibling + 1 }, (_, i) => leftSibling + i),
    'ellipsis',
    total,
  ]
}
