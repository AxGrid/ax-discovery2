import { forwardRef } from 'react'
import type { TextareaHTMLAttributes } from 'react'
import { cn } from './utils'

export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  invalid?: boolean
}

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, invalid, ...props }, ref) => {
    return (
      <textarea
        ref={ref}
        className={cn(
          'w-full min-h-24 rounded-[var(--radius-md)] border bg-bg-elevated px-3 py-2.5',
          'text-sm text-fg shadow-xs outline-none resize-y',
          'placeholder:text-fg-subtle',
          'transition-[box-shadow,border-color]',
          'focus-visible:[box-shadow:0_0_0_2px_var(--bg),0_0_0_4px_var(--ring)]',
          'disabled:cursor-not-allowed disabled:opacity-50',
          invalid
            ? 'border-danger focus-visible:[box-shadow:0_0_0_2px_var(--bg),0_0_0_4px_color-mix(in_oklab,var(--danger)_50%,transparent)]'
            : 'border-border focus-visible:border-accent',
          className
        )}
        {...props}
      />
    )
  }
)
Textarea.displayName = 'Textarea'
