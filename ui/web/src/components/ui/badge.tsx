import type { HTMLAttributes } from 'react'
import { cva, type VariantProps } from 'class-variance-authority'
import { cn } from './utils'

export const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full font-medium tracking-tight whitespace-nowrap [&_svg]:size-3',
  {
    variants: {
      variant: {
        brand:    'bg-[color-mix(in_oklab,var(--brand-500)_15%,transparent)] text-accent border border-[color-mix(in_oklab,var(--brand-500)_25%,transparent)]',
        solid:    'bg-accent text-accent-fg',
        neutral:  'bg-surface-2 text-fg border border-border',
        outline:  'bg-transparent text-fg border border-border',
        success:  'bg-success-bg text-success border border-[color-mix(in_oklab,var(--success)_25%,transparent)]',
        warning:  'bg-warning-bg text-warning border border-[color-mix(in_oklab,var(--warning)_25%,transparent)]',
        danger:   'bg-danger-bg text-danger border border-[color-mix(in_oklab,var(--danger)_25%,transparent)]',
        info:     'bg-info-bg text-info border border-[color-mix(in_oklab,var(--info)_25%,transparent)]',
      },
      size: {
        sm: 'h-5 px-2 text-[11px]',
        md: 'h-6 px-2.5 text-xs',
      },
    },
    defaultVariants: { variant: 'brand', size: 'md' },
  }
)

export interface BadgeProps
  extends HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {
  dot?: boolean
}

export function Badge({ className, variant, size, dot, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ variant, size }), className)} {...props}>
      {dot ? (
        <span className="size-1.5 rounded-full bg-current opacity-90" aria-hidden />
      ) : null}
      {children}
    </span>
  )
}
