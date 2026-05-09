import { forwardRef } from 'react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { Slot } from '@radix-ui/react-slot'
import { cva, type VariantProps } from 'class-variance-authority'
import { Loader2 } from 'lucide-react'
import { cn } from './utils'

export const buttonVariants = cva(
  [
    'inline-flex items-center justify-center gap-2 select-none whitespace-nowrap',
    'font-medium tracking-tight',
    'rounded-[var(--radius-md)]',
    'transition-[background-color,color,box-shadow,transform] duration-150',
    'focus-visible:outline-none',
    'focus-visible:[box-shadow:0_0_0_2px_var(--bg),0_0_0_4px_var(--ring)]',
    'disabled:pointer-events-none disabled:opacity-50',
    'active:scale-[0.98]',
    '[&_svg]:size-4 [&_svg]:shrink-0',
  ].join(' '),
  {
    variants: {
      variant: {
        primary: [
          'bg-accent text-accent-fg shadow-sm',
          'hover:bg-accent-hover',
          'active:bg-accent-active',
        ].join(' '),
        secondary: [
          'bg-surface-2 text-fg shadow-xs',
          'hover:bg-surface-hover',
        ].join(' '),
        outline: [
          'bg-transparent text-fg border border-border',
          'hover:bg-surface hover:border-border-strong',
        ].join(' '),
        ghost: [
          'bg-transparent text-fg',
          'hover:bg-surface',
        ].join(' '),
        danger: [
          'bg-danger text-danger-fg shadow-sm',
          'hover:opacity-90',
        ].join(' '),
        link: [
          'bg-transparent text-accent underline-offset-4',
          'hover:underline px-0 h-auto',
        ].join(' '),
      },
      size: {
        sm: 'h-8 px-3 text-[13px]',
        md: 'h-10 px-4 text-sm',
        lg: 'h-12 px-6 text-base',
        icon: 'h-10 w-10 p-0',
      },
    },
    defaultVariants: { variant: 'primary', size: 'md' },
  }
)

export interface ButtonProps
  extends ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
  loading?: boolean
  leftIcon?: ReactNode
  rightIcon?: ReactNode
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    { className, variant, size, asChild, loading, disabled, leftIcon, rightIcon, children, ...props },
    ref
  ) => {
    const Comp = asChild ? Slot : 'button'
    // Slot requires a single React element child. When `asChild` is used,
    // hand the user's element through untouched and rely on them for inner layout.
    const content = asChild
      ? children
      : (
        <>
          {loading ? <Loader2 className="animate-spin" /> : leftIcon}
          {children}
          {!loading && rightIcon}
        </>
      )
    return (
      <Comp
        ref={ref}
        className={cn(buttonVariants({ variant, size, className }))}
        disabled={disabled || loading}
        {...props}
      >
        {content}
      </Comp>
    )
  }
)
Button.displayName = 'Button'
