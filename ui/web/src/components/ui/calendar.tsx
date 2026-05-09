import { ChevronLeft, ChevronRight } from 'lucide-react'
import { DayPicker } from 'react-day-picker'
import type { DayPickerProps } from 'react-day-picker'
import { de, enUS, es, ru } from 'date-fns/locale'
import type { Locale as DateFnsLocale } from 'date-fns'
import { useI18n } from './i18n'
import type { Locale } from './i18n'
import { cn } from './utils'

const LOCALE_MAP: Record<Locale, DateFnsLocale> = {
  ru, en: enUS, es, de,
}

export function getDateLocale(locale: Locale): DateFnsLocale {
  return LOCALE_MAP[locale]
}

/**
 * Calendar — react-day-picker v9 wrapper, fully styled via classNames.
 * The default CSS from `react-day-picker/style.css` is intentionally NOT imported:
 * its rules sit in the unlayered cascade and would override our themed Tailwind
 * utilities. Everything below is hand-rolled so light/dark range colors stay correct.
 */
export function Calendar({
  className,
  classNames,
  showOutsideDays = true,
  ...props
}: DayPickerProps) {
  const { locale } = useI18n()

  const navBtn = cn(
    'inline-flex size-8 items-center justify-center rounded-[var(--radius-sm)]',
    'text-fg-muted hover:bg-surface hover:text-fg transition-colors',
    'disabled:opacity-30 disabled:hover:bg-transparent'
  )

  const stripeBg = 'bg-[color-mix(in_oklab,var(--brand-500)_14%,transparent)]'

  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      locale={LOCALE_MAP[locale]}
      weekStartsOn={locale === 'en' ? 0 : 1}
      className={cn('p-2', className)}
      classNames={{
        // Layout
        months: 'flex flex-col sm:flex-row gap-6',
        month: 'flex flex-col gap-3 relative',
        month_caption: 'flex h-9 items-center justify-center text-sm font-semibold tracking-tight capitalize',
        caption_label: 'capitalize',
        nav: 'absolute inset-x-0 top-0 z-10 flex items-center justify-between px-1',
        button_previous: navBtn,
        button_next: navBtn,
        month_grid: 'border-collapse',
        weekdays: 'flex',
        weekday: 'w-9 text-[11px] font-medium uppercase tracking-wider text-fg-subtle py-1',
        week: 'flex w-full mt-1',

        // Day cell (the <td>)
        day: 'relative size-9 p-0 text-center text-sm',

        // Day button — base look
        day_button: cn(
          'size-9 inline-flex items-center justify-center rounded-full',
          'text-sm font-medium text-fg bg-transparent',
          'transition-colors hover:bg-surface',
          'focus-visible:outline-none focus-visible:[box-shadow:0_0_0_2px_var(--bg),0_0_0_3px_var(--ring)]'
        ),

        // Modifiers (applied to the <td>)
        // For single-mode selection — only `selected` fires, not range_*.
        selected: cn(
          '[&>button]:bg-accent [&>button]:text-accent-fg',
          '[&>button]:hover:bg-accent-hover'
        ),
        today: '[&>button]:font-semibold [&>button]:text-accent',
        outside: '[&>button]:text-fg-subtle/60',
        disabled: 'opacity-30 pointer-events-none',
        hidden: 'invisible',

        // Range edges — keep the solid pill on the day, paint the cell
        // half-stripe so it joins range_middle smoothly.
        range_start: cn(
          stripeBg,
          'rounded-l-full',
          '[&>button]:!bg-accent [&>button]:!text-accent-fg [&>button]:hover:!bg-accent-hover',
          '[&>button]:!rounded-full'
        ),
        range_end: cn(
          stripeBg,
          'rounded-r-full',
          '[&>button]:!bg-accent [&>button]:!text-accent-fg [&>button]:hover:!bg-accent-hover',
          '[&>button]:!rounded-full'
        ),
        // Range middle — the stripe between start and end. Cell holds the bg,
        // the inner button is forced transparent with foreground-color text so
        // the digits stay readable in BOTH themes.
        range_middle: cn(
          stripeBg,
          '[&>button]:!bg-transparent',
          '[&>button]:!text-fg',
          '[&>button]:!rounded-none',
          '[&>button]:hover:!bg-[color-mix(in_oklab,var(--brand-500)_22%,transparent)]'
        ),

        ...classNames,
      }}
      components={{
        Chevron: ({ orientation }) =>
          orientation === 'left'
            ? <ChevronLeft className="size-4" />
            : <ChevronRight className="size-4" />,
      }}
      {...props}
    />
  )
}
