import { forwardRef } from 'react'
import type { HTMLAttributes } from 'react'
import * as DialogPrimitive from '@radix-ui/react-dialog'
import { X } from 'lucide-react'
import { cn } from './utils'

/**
 * Side drawer built on top of Radix Dialog. Slides in from the right by default.
 * Use Drawer / DrawerTrigger / DrawerContent etc.
 */
export const Drawer = DialogPrimitive.Root
export const DrawerTrigger = DialogPrimitive.Trigger
export const DrawerClose = DialogPrimitive.Close
export const DrawerPortal = DialogPrimitive.Portal

const sideClasses = {
  right: [
    'inset-y-0 right-0 h-full w-full max-w-md border-l',
    'data-[state=open]:slide-in-from-right data-[state=closed]:slide-out-to-right',
  ].join(' '),
  left: [
    'inset-y-0 left-0 h-full w-full max-w-md border-r',
    'data-[state=open]:slide-in-from-left data-[state=closed]:slide-out-to-left',
  ].join(' '),
  top: [
    'inset-x-0 top-0 w-full border-b',
    'data-[state=open]:slide-in-from-top data-[state=closed]:slide-out-to-top',
  ].join(' '),
  bottom: [
    'inset-x-0 bottom-0 w-full border-t rounded-t-[var(--radius-2xl)]',
    'data-[state=open]:slide-in-from-bottom data-[state=closed]:slide-out-to-bottom',
  ].join(' '),
}

export const DrawerContent = forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> & {
    side?: 'right' | 'left' | 'top' | 'bottom'
  }
>(({ className, children, side = 'right', ...props }, ref) => (
  <DrawerPortal>
    <DialogPrimitive.Overlay
      className={cn(
        'fixed inset-0 z-50 bg-overlay backdrop-blur-md',
        'data-[state=open]:animate-in data-[state=closed]:animate-out',
        'data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0'
      )}
    />
    <DialogPrimitive.Content
      ref={ref}
      className={cn(
        'fixed z-50 flex flex-col gap-4 bg-bg-elevated p-6 shadow-xl border-border',
        'duration-300 data-[state=open]:animate-in data-[state=closed]:animate-out',
        sideClasses[side],
        className
      )}
      {...props}
    >
      {children}
      <DrawerClose
        className={cn(
          'absolute right-4 top-4 inline-flex size-8 items-center justify-center rounded-[var(--radius-sm)]',
          'text-fg-muted hover:bg-surface hover:text-fg transition-colors',
          'focus-visible:outline-none',
          'focus-visible:[box-shadow:0_0_0_2px_var(--bg),0_0_0_4px_var(--ring)]'
        )}
      >
        <X className="size-4" />
        <span className="sr-only">Close</span>
      </DrawerClose>
    </DialogPrimitive.Content>
  </DrawerPortal>
))
DrawerContent.displayName = 'DrawerContent'

export function DrawerHeader({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return <div className={cn('flex flex-col gap-1.5 pr-8', className)} {...props} />
}

export function DrawerFooter({ className, ...props }: HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn('mt-auto flex flex-col-reverse gap-2 sm:flex-row sm:justify-end', className)}
      {...props}
    />
  )
}

export const DrawerTitle = forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Title>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Title>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Title
    ref={ref}
    className={cn('text-lg font-semibold tracking-tight text-fg', className)}
    {...props}
  />
))
DrawerTitle.displayName = 'DrawerTitle'

export const DrawerDescription = forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Description>,
  React.ComponentPropsWithoutRef<typeof DialogPrimitive.Description>
>(({ className, ...props }, ref) => (
  <DialogPrimitive.Description
    ref={ref}
    className={cn('text-sm text-fg-muted leading-relaxed', className)}
    {...props}
  />
))
DrawerDescription.displayName = 'DrawerDescription'
