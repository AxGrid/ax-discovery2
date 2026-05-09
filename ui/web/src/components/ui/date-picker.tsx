import { useState } from 'react'
import { format, set, startOfDay, subDays } from 'date-fns'
import { CalendarIcon, X } from 'lucide-react'
import { Calendar, getDateLocale } from './calendar'
import { Popover, PopoverContent, PopoverTrigger } from './popover'
import { Button } from './button'
import { useI18n } from './i18n'
import { cn } from './utils'

export type DatePreset = {
  id: string
  label: string
  getValue: () => Date
}

export const defaultDatePresets = (t: (k: string) => string): DatePreset[] => [
  { id: 'today',     label: t('datepicker.preset.today'),     getValue: () => startOfDay(new Date()) },
  { id: 'yesterday', label: t('datepicker.preset.yesterday'), getValue: () => subDays(startOfDay(new Date()), 1) },
  { id: 'weekAgo',   label: t('datepicker.preset.weekAgo'),   getValue: () => subDays(startOfDay(new Date()), 7) },
  { id: 'monthAgo',  label: t('datepicker.preset.monthAgo'),  getValue: () => subDays(startOfDay(new Date()), 30) },
]

export interface DatePickerProps {
  value?: Date
  onChange?: (d: Date | undefined) => void
  placeholder?: string
  withTime?: boolean
  presets?: DatePreset[] | null
  className?: string
  disabled?: boolean
}

export function DatePicker({
  value,
  onChange,
  placeholder,
  withTime,
  presets,
  className,
  disabled,
}: DatePickerProps) {
  const { t, locale } = useI18n()
  const [open, setOpen] = useState(false)
  const finalPresets = presets === null ? null : (presets ?? defaultDatePresets(t))

  function setDate(d: Date | undefined) {
    if (!d) {
      onChange?.(undefined)
      return
    }
    if (withTime && value) {
      onChange?.(set(d, { hours: value.getHours(), minutes: value.getMinutes() }))
    } else {
      onChange?.(d)
    }
  }

  function setTime(timeStr: string) {
    const [h, m] = timeStr.split(':').map(Number)
    const base = value ?? new Date()
    onChange?.(set(base, { hours: h || 0, minutes: m || 0, seconds: 0, milliseconds: 0 }))
  }

  const fmt = withTime ? 'PPP, HH:mm' : 'PPP'
  const display = value ? format(value, fmt, { locale: getDateLocale(locale) }) : null

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
            {display ?? placeholder ?? t('datepicker.placeholder.date')}
          </span>
          {value ? (
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
            <div className="border-r border-border p-2 flex flex-col gap-0.5 min-w-32">
              {finalPresets.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  onClick={() => { onChange?.(p.getValue()); setOpen(false) }}
                  className="text-left px-2.5 py-1.5 rounded-[var(--radius-sm)] text-sm hover:bg-surface transition-colors"
                >
                  {p.label}
                </button>
              ))}
            </div>
          ) : null}
          <div className="p-2">
            <Calendar
              mode="single"
              selected={value}
              onSelect={(d) => { setDate(d); if (!withTime) setOpen(false) }}
              defaultMonth={value}
            />
            {withTime ? (
              <div className="flex items-center gap-2 border-t border-border px-2 pt-3 mt-1">
                <span className="text-xs text-fg-muted">{t('datepicker.time')}</span>
                <input
                  type="time"
                  value={value ? format(value, 'HH:mm') : ''}
                  onChange={(e) => setTime(e.target.value)}
                  className={cn(
                    'h-8 rounded-[var(--radius-sm)] border border-border bg-bg-elevated px-2 text-sm',
                    'focus-visible:outline-none focus-visible:border-accent'
                  )}
                />
                <Button size="sm" className="ml-auto" onClick={() => setOpen(false)}>
                  {t('btn.continue')}
                </Button>
              </div>
            ) : null}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  )
}
