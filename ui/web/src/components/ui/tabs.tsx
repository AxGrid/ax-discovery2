import { createContext, forwardRef, useContext, useMemo } from 'react'
import * as TabsPrimitive from '@radix-ui/react-tabs'
import { cn } from './utils'

export type TabsVariant = 'default' | 'underline' | 'pills' | 'subtle'

type TabsContextValue = {
  variant: TabsVariant
  orientation: 'horizontal' | 'vertical'
}

const TabsContext = createContext<TabsContextValue>({
  variant: 'default',
  orientation: 'horizontal',
})

export const Tabs = forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Root> & {
    variant?: TabsVariant
  }
>(({ variant = 'default', orientation = 'horizontal', ...props }, ref) => {
  const value = useMemo(() => ({ variant, orientation }), [variant, orientation])
  return (
    <TabsContext.Provider value={value}>
      <TabsPrimitive.Root ref={ref} orientation={orientation} {...props} />
    </TabsContext.Provider>
  )
})
Tabs.displayName = TabsPrimitive.Root.displayName

export const TabsList = forwardRef<
  React.ComponentRef<typeof TabsPrimitive.List>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.List>
>(({ className, ...props }, ref) => {
  const { variant, orientation } = useContext(TabsContext)
  return (
    <TabsPrimitive.List
      ref={ref}
      className={cn(
        'inline-flex items-center',
        orientation === 'vertical' ? 'flex-col h-auto items-stretch' : 'h-10',
        // Variant-specific container styles
        variant === 'default' &&
          (orientation === 'vertical'
            ? 'w-44 gap-1 rounded-[var(--radius-md)] border border-border bg-surface p-1'
            : 'gap-1 rounded-[var(--radius-md)] bg-surface p-1 border border-border'),
        variant === 'underline' &&
          (orientation === 'vertical'
            ? 'w-44 gap-0.5 border-r border-border'
            : 'gap-2 border-b border-border'),
        variant === 'pills' &&
          'gap-1.5',
        variant === 'subtle' &&
          'gap-1',
        className
      )}
      {...props}
    />
  )
})
TabsList.displayName = TabsPrimitive.List.displayName

export const TabsTrigger = forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Trigger>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Trigger>
>(({ className, ...props }, ref) => {
  const { variant, orientation } = useContext(TabsContext)
  return (
    <TabsPrimitive.Trigger
      ref={ref}
      className={cn(
        'inline-flex items-center justify-center gap-2 whitespace-nowrap',
        'text-sm font-medium text-fg-muted transition-all',
        'focus-visible:outline-none focus-visible:[box-shadow:0_0_0_2px_var(--bg),0_0_0_4px_var(--ring)]',
        'disabled:pointer-events-none disabled:opacity-50',
        '[&_svg]:size-4 [&_svg]:shrink-0',
        // default = segmented (current behavior)
        variant === 'default' && [
          'rounded-[var(--radius-sm)] px-3 py-1.5',
          'hover:text-fg',
          'data-[state=active]:bg-bg-elevated data-[state=active]:text-fg data-[state=active]:shadow-xs',
          orientation === 'vertical' && 'justify-start',
        ],
        // underline = bottom border on active
        variant === 'underline' && [
          'relative px-1 py-2.5 -mb-px',
          'hover:text-fg',
          'data-[state=active]:text-fg',
          orientation === 'horizontal'
            ? 'data-[state=active]:after:content-[""] data-[state=active]:after:absolute data-[state=active]:after:left-0 data-[state=active]:after:right-0 data-[state=active]:after:-bottom-px data-[state=active]:after:h-0.5 data-[state=active]:after:bg-accent data-[state=active]:after:rounded-full'
            : 'justify-start py-2 pr-3 -mr-px data-[state=active]:after:content-[""] data-[state=active]:after:absolute data-[state=active]:after:top-0 data-[state=active]:after:bottom-0 data-[state=active]:after:-right-px data-[state=active]:after:w-0.5 data-[state=active]:after:bg-accent data-[state=active]:after:rounded-full',
        ],
        // pills = rounded-full background swap
        variant === 'pills' && [
          'rounded-full px-3.5 py-1.5',
          'hover:text-fg hover:bg-surface',
          'data-[state=active]:bg-accent data-[state=active]:text-accent-fg data-[state=active]:hover:bg-accent-hover',
          orientation === 'vertical' && 'justify-start',
        ],
        // subtle = colored bg on active, no shape change
        variant === 'subtle' && [
          'rounded-[var(--radius-sm)] px-3 py-1.5',
          'hover:text-fg hover:bg-surface',
          'data-[state=active]:bg-[color-mix(in_oklab,var(--brand-500)_15%,transparent)] data-[state=active]:text-accent',
          orientation === 'vertical' && 'justify-start',
        ],
        className
      )}
      {...props}
    />
  )
})
TabsTrigger.displayName = TabsPrimitive.Trigger.displayName

export const TabsContent = forwardRef<
  React.ComponentRef<typeof TabsPrimitive.Content>,
  React.ComponentPropsWithoutRef<typeof TabsPrimitive.Content>
>(({ className, ...props }, ref) => (
  <TabsPrimitive.Content
    ref={ref}
    className={cn(
      'mt-4 focus-visible:outline-none',
      'data-[state=active]:animate-in data-[state=active]:fade-in-50',
      className
    )}
    {...props}
  />
))
TabsContent.displayName = TabsPrimitive.Content.displayName
