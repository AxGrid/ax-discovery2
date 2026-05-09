import { useState } from 'react'
import {
  endOfDay,
  endOfMonth,
  endOfWeek,
  format,
  startOfDay,
  startOfMonth,
  startOfWeek,
  startOfYear,
  subDays,
  subHours,
  subMonths,
} from 'date-fns'
import type { DateRange } from 'react-day-picker'
import { CalendarIcon, X } from 'lucide-react'
import { Calendar, getDateLocale } from './calendar'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { Button } from './button'
import { useI18n } from './i18n'
import { cn } from './utils'

export type DateRangePreset = {
  id: string
  label: string
  getValue: () => DateRange
}

export const defaultDateRangePresets = (t: (k: string) => string, weekStartsOn: 0 | 1 = 1): DateRangePreset[] => {
  const today = () => startOfDay(new Date())
  const now = () => new Date()
  return [
    { id: 'today',      label: t('datepicker.preset.today'),       getValue: () => ({ from: today(), to: endOfDay(new Date()) }) },
    { id: 'yesterday',  label: t('datepicker.preset.yesterday'),   getValue: () => ({ from: subDays(today(), 1), to: endOfDay(subDays(new Date(), 1)) }) },
    { id: 'last24h',    label: t('datepicker.preset.last24h'),     getValue: () => ({ from: subHours(now(), 24), to: now() }) },
    { id: 'last7d',     label: t('datepicker.preset.last7d'),      getValue: () => ({ from: subDays(today(), 6), to: endOfDay(new Date()) }) },
    { id: 'last30d',    label: t('datepicker.preset.last30d'),     getValue: () => ({ from: subDays(today(), 29), to: endOfDay(new Date()) }) },
    { id: 'thisWeek',   label: t('datepicker.preset.thisWeek'),    getValue: () => ({ from: startOfWeek(today(), { weekStartsOn }), to: endOfDay(new Date()) }) },
    { id: 'lastWeek',   label: t('datepicker.preset.lastWeek'),    getValue: () => {
      const lw = subDays(today(), 7)
      return { from: startOfWeek(lw, { weekStartsOn }), to: endOfWeek(lw, { weekStartsOn }) }
    }},
    { id: 'thisMonth',  label: t('datepicker.preset.thisMonth'),   getValue: () => ({ from: startOfMonth(today()), to: endOfDay(new Date()) }) },
    { id: 'lastMonth',  label: t('datepicker.preset.lastMonth'),   getValue: () => {
      const lm = subMonths(today(), 1)
      return { from: startOfMonth(lm), to: endOfMonth(lm) }
    }},
    { id: 'thisYear',   label: t('datepicker.preset.thisYear'),    getValue: () => ({ from: startOfYear(today()), to: endOfDay(new Date()) }) },
  ]
}

export interface DateRangePickerProps {
  value?: DateRange
  onChange?: (r: DateRange | undefined) => void
  placeholder?: string
  presets?: DateRangePreset[] | null
  numberOfMonths?: number
  className?: string
  disabled?: boolean
}

export function DateRangePicker({
  value,
  onChange,
  placeholder,
  presets,
  numberOfMonths = 2,
  className,
  disabled,
}: DateRangePickerProps) {
  const { t, locale } = useI18n()
  const [open, setOpen] = useState(false)
  const weekStartsOn: 0 | 1 = locale === 'en' ? 0 : 1
  const finalPresets = presets === null ? null : (presets ?? defaultDateRangePresets(t, weekStartsOn))

  const fmt = 'PP'
  const dateLocale = getDateLocale(locale)
  const display = value?.from
    ? value.to
      ? `${format(value.from, fmt, { locale: dateLocale })} — ${format(value.to, fmt, { locale: dateLocale })}`
      : format(value.from, fmt, { locale: dateLocale })
    : null

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          className={cn(
            'inline-flex h-10 w-full items-center gap-2 rounded-[var(--radius-md)] border border-border',
            'bg-bg-elevated px-3 text-left text-sm shadow-xs transition-[box-shadow,border-color]',
            'hover:bg-surface',
            'focus-visible:outline-none focus-visible:[box-shadow:0_0_0_2px_var(--bg),0_0_0_4px_var(--ring)]',
            'data-[state=open]:border-accent',
            'disabled:opacity-50 disabled:cursor-not-allowed',
            !display && 'text-fg-subtle',
            className
          )}
        >
          <CalendarIcon className="size-4 text-fg-muted shrink-0" />
          <span className="flex-1 truncate">
            {display ?? placeholder ?? t('datepicker.placeholder.range')}
          </span>
          {value?.from ? (
            <span
              role="button"
              tabIndex={-1}
              onClick={(e) => { e.stopPropagation(); onChange?.(undefined) }}
              className="text-fg-muted hover:text-fg transition-colors p-0.5 rounded-[var(--radius-xs)]"
              aria-label="Clear"
            >
              <X className="size-3.5" />
            </span>
          ) : null}
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-auto p-0">
        <div className="flex">
          {finalPresets ? (
            <div className="border-r border-border p-2 flex flex-col gap-0.5 min-w-44 max-h-[360px] overflow-auto">
              {finalPresets.map((p) => {
                const v = value
                const candidate = p.getValue()
                const isActive =
                  v?.from && v?.to &&
                  Math.abs(+v.from - +candidate.from!) < 1000 * 60 &&
                  Math.abs(+(v.to ?? 0) - +(candidate.to ?? 0)) < 1000 * 60
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => { onChange?.(p.getValue()); setOpen(false) }}
                    className={cn(
                      'text-left px-2.5 py-1.5 rounded-[var(--radius-sm)] text-sm transition-colors',
                      'hover:bg-surface',
                      isActive && 'bg-[color-mix(in_oklab,var(--brand-500)_15%,transparent)] text-accent'
                    )}
                  >
                    {p.label}
                  </button>
                )
              })}
            </div>
          ) : null}
          <div className="p-2">
            <Calendar
              mode="range"
              numberOfMonths={numberOfMonths}
              selected={value}
              onSelect={onChange}
              defaultMonth={value?.from}
            />
            <div className="flex items-center gap-2 border-t border-border px-2 pt-3 mt-1">
              <Button size="sm" variant="ghost" onClick={() => onChange?.(undefined)}>
                {t('btn.cancel')}
              </Button>
              <Button size="sm" className="ml-auto" onClick={() => setOpen(false)} disabled={!value?.from}>
                {t('btn.continue')}
              </Button>
            </div>
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
