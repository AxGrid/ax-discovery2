import { forwardRef } from 'react'
import type { InputHTMLAttributes, ReactNode } from 'react'
import { cn } from './utils'

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  leftIcon?: ReactNode
  rightSlot?: ReactNode
  invalid?: boolean
}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = 'text', leftIcon, rightSlot, invalid, disabled, ...props }, ref) => {
    return (
      <div
        className={cn(
          'group relative flex h-10 w-full items-center gap-2',
          'rounded-[var(--radius-md)] border bg-bg-elevated px-3',
          'shadow-xs transition-[box-shadow,border-color]',
          'has-[input:focus-visible]:[box-shadow:0_0_0_2px_var(--bg),0_0_0_4px_var(--ring)]',
          invalid
            ? 'border-danger has-[input:focus-visible]:[box-shadow:0_0_0_2px_var(--bg),0_0_0_4px_color-mix(in_oklab,var(--danger)_50%,transparent)]'
            : 'border-border has-[input:focus-visible]:border-accent',
          disabled && 'opacity-50 cursor-not-allowed',
          className
        )}
      >
        {leftIcon ? (
          <span className="text-fg-muted [&>svg]:size-4 shrink-0">{leftIcon}</span>
        ) : null}
        <input
          ref={ref}
          type={type}
          disabled={disabled}
          className={cn(
            'peer flex-1 bg-transparent text-sm text-fg outline-none',
            'placeholder:text-fg-subtle',
            'disabled:cursor-not-allowed',
          )}
          {...props}
        />
        {rightSlot ? <span className="shrink-0">{rightSlot}</span> : null}
      </div>
    )
  }
)
Input.displayName = 'Input'
