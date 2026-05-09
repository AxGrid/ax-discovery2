import { Languages } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './dropdown-menu'
import { LOCALES, LOCALE_LABELS, useI18n } from './i18n'
import type { Locale } from './i18n'
import { cn } from './utils'

export function LangSwitcher({ className }: { className?: string }) {
  const { locale, setLocale, t } = useI18n()
  const current = LOCALE_LABELS[locale]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        className={cn(
          'inline-flex h-10 items-center gap-2 rounded-[var(--radius-md)] border border-border',
          'bg-bg-elevated px-3 text-sm font-medium text-fg shadow-xs',
          'hover:bg-surface transition-colors',
          'focus-visible:outline-none focus-visible:[box-shadow:0_0_0_2px_var(--bg),0_0_0_4px_var(--ring)]',
          'data-[state=open]:bg-surface',
          className
        )}
      >
        <Languages className="size-4 text-fg-muted" />
        <span className="text-base leading-none">{current.flag}</span>
        <span className="uppercase tracking-wide text-xs text-fg-muted">{locale}</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-44">
        <DropdownMenuLabel>{t('lang.label')}</DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuRadioGroup value={locale} onValueChange={(v) => setLocale(v as Locale)}>
          {LOCALES.map((l) => (
            <DropdownMenuRadioItem key={l} value={l}>
              <span className="mr-2 text-base leading-none">{LOCALE_LABELS[l].flag}</span>
              {LOCALE_LABELS[l].name}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
