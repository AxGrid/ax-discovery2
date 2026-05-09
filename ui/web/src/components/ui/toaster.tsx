import { Toaster as Sonner, type ToasterProps } from 'sonner'
import { useTheme } from './theme'

/**
 * Toast container. Mount once at the root of the app.
 * Use the `toast()` API from "sonner" anywhere to fire notifications.
 */
export function Toaster(props: ToasterProps) {
  const { theme } = useTheme()
  return (
    <Sonner
      theme={theme}
      position="top-right"
      offset={20}
      richColors={false}
      closeButton
      duration={4000}
      toastOptions={{
        classNames: {
          toast: [
            'group toast pointer-events-auto',
            '!bg-bg-elevated !text-fg !border !border-border',
            '!rounded-[var(--radius-lg)] !shadow-lg',
            '!backdrop-blur-md',
          ].join(' '),
          title: '!text-fg !font-semibold !text-sm',
          description: '!text-fg-muted !text-sm',
          actionButton: '!bg-accent !text-accent-fg !rounded-[var(--radius-sm)]',
          cancelButton: '!bg-surface-2 !text-fg !rounded-[var(--radius-sm)]',
          closeButton:
            '!bg-bg-elevated !border-border !text-fg-muted hover:!bg-surface',
          success:
            'group-data-[type=success]:!border-[color-mix(in_oklab,var(--success)_30%,transparent)]',
          error:
            'group-data-[type=error]:!border-[color-mix(in_oklab,var(--danger)_30%,transparent)]',
          info: 'group-data-[type=info]:!border-[color-mix(in_oklab,var(--info)_30%,transparent)]',
          warning:
            'group-data-[type=warning]:!border-[color-mix(in_oklab,var(--warning)_30%,transparent)]',
        },
      }}
      {...props}
    />
  )
}
