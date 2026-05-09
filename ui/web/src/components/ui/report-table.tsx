import { useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ArrowUpDown, Search } from 'lucide-react'
import { format } from 'date-fns'
import { Avatar, AvatarFallback, AvatarImage } from './avatar'
import { Badge } from './badge'
import { Input } from './input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from './select'
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
  paginationRange,
} from './pagination'
import { useI18n } from './i18n'
import { cn } from './utils'
import { getDateLocale } from './calendar'

type Row = {
  id: number
  name: string
  email: string
  role: 'admin' | 'editor' | 'viewer' | 'guest'
  plan: 'free' | 'pro' | 'team'
  status: 'active' | 'invited' | 'suspended' | 'trial'
  mrr: number
  signup: Date
  activity: number
  avatar: string
}

const FIRST = ['Anna', 'Marco', 'Yuki', 'Ravi', 'Sofia', 'Lukas', 'Nora', 'Ivan', 'Diego', 'Hana', 'Elena', 'Omar', 'Mei', 'Petr', 'Lisa']
const LAST  = ['Karenina', 'Liano', 'Sato', 'Patel', 'Reyes', 'Müller', 'Berg', 'Petrov', 'Costa', 'Tanaka', 'Vega', 'Khan', 'Wong', 'Novak', 'Stein']
const ROLES: Row['role'][] = ['admin', 'editor', 'viewer', 'guest']
const PLANS: Row['plan'][] = ['free', 'pro', 'team']
const STATUSES: Row['status'][] = ['active', 'active', 'active', 'invited', 'trial', 'suspended']

// Deterministic PRNG so the demo data is stable between renders.
function mulberry32(a: number) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rand = mulberry32(42)

const ROWS: Row[] = Array.from({ length: 50 }, (_, i) => {
  const f = FIRST[Math.floor(rand() * FIRST.length)]
  const l = LAST[Math.floor(rand() * LAST.length)]
  const role = ROLES[Math.floor(rand() * ROLES.length)]
  const plan = PLANS[Math.floor(rand() * PLANS.length)]
  const status = STATUSES[Math.floor(rand() * STATUSES.length)]
  const mrr = plan === 'free' ? 0 : plan === 'pro' ? 19 + Math.floor(rand() * 30) : 99 + Math.floor(rand() * 200)
  const days = Math.floor(rand() * 720)
  const signup = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
  const activity = Math.floor(rand() * 100)
  const avatarId = 1 + Math.floor(rand() * 70)
  const avatar = rand() > 0.2 ? `https://i.pravatar.cc/64?img=${avatarId}` : ''
  return {
    id: i + 1,
    name: `${f} ${l}`,
    email: `${f.toLowerCase()}.${l.toLowerCase()}@ax-styler.dev`,
    role,
    plan,
    status,
    mrr,
    signup,
    activity,
    avatar,
  }
})

type SortKey = 'name' | 'plan' | 'status' | 'mrr' | 'signup' | 'activity'
type SortDir = 'asc' | 'desc'

export function ReportTableDemo() {
  const { t, locale } = useI18n()
  const [sortKey, setSortKey] = useState<SortKey>('mrr')
  const [sortDir, setSortDir] = useState<SortDir>('desc')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(10)

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortKey(key); setSortDir(key === 'mrr' || key === 'activity' || key === 'signup' ? 'desc' : 'asc') }
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return ROWS
    return ROWS.filter(r =>
      r.name.toLowerCase().includes(q) ||
      r.email.toLowerCase().includes(q) ||
      r.role.includes(q) ||
      r.plan.includes(q) ||
      r.status.includes(q)
    )
  }, [query])

  const sorted = useMemo(() => {
    const arr = [...filtered]
    arr.sort((a, b) => {
      let av: number | string
      let bv: number | string
      switch (sortKey) {
        case 'name': av = a.name; bv = b.name; break
        case 'plan': av = a.plan; bv = b.plan; break
        case 'status': av = a.status; bv = b.status; break
        case 'mrr': av = a.mrr; bv = b.mrr; break
        case 'activity': av = a.activity; bv = b.activity; break
        case 'signup': av = +a.signup; bv = +b.signup; break
      }
      const cmp = av < bv ? -1 : av > bv ? 1 : 0
      return sortDir === 'asc' ? cmp : -cmp
    })
    return arr
  }, [filtered, sortKey, sortDir])

  // When the dataset shrinks/changes, snap back to a valid page.
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize))
  useEffect(() => { if (page > totalPages) setPage(1) }, [page, totalPages])
  useEffect(() => { setPage(1) }, [query, sortKey, sortDir, pageSize])

  const pageRows = useMemo(
    () => sorted.slice((page - 1) * pageSize, page * pageSize),
    [sorted, page, pageSize]
  )
  const fromItem = sorted.length === 0 ? 0 : (page - 1) * pageSize + 1
  const toItem   = Math.min(page * pageSize, sorted.length)

  const dateLocale = getDateLocale(locale)
  const fmtMoney = (n: number) =>
    n === 0 ? '—' : new Intl.NumberFormat(locale === 'en' ? 'en-US' : locale, { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(n)

  const items = paginationRange(page, totalPages, 1)

  return (
    <div>
      <div className="flex flex-wrap items-center gap-3 mb-4">
        <div className="max-w-xs flex-1 min-w-48">
          <Input
            leftIcon={<Search />}
            placeholder={t('table.search')}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <span className="ml-auto text-xs font-mono text-fg-muted">
          {t('table.rowsCount', { n: sorted.length })}
        </span>
      </div>

      <div className="rounded-[var(--radius-lg)] border border-border bg-bg-elevated overflow-hidden">
        <table className="w-full caption-bottom text-sm border-separate border-spacing-0">
          <thead className="bg-surface/60">
            <tr>
              <SortableTh active={sortKey === 'name'} dir={sortDir} onClick={() => toggleSort('name')}>
                {t('table.col.user')}
              </SortableTh>
              <Th>{t('table.col.role')}</Th>
              <SortableTh active={sortKey === 'plan'} dir={sortDir} onClick={() => toggleSort('plan')}>
                {t('table.col.plan')}
              </SortableTh>
              <SortableTh active={sortKey === 'status'} dir={sortDir} onClick={() => toggleSort('status')}>
                {t('table.col.status')}
              </SortableTh>
              <SortableTh
                active={sortKey === 'mrr'} dir={sortDir} onClick={() => toggleSort('mrr')}
                className="text-right"
              >
                {t('table.col.mrr')}
              </SortableTh>
              <SortableTh active={sortKey === 'signup'} dir={sortDir} onClick={() => toggleSort('signup')}>
                {t('table.col.signup')}
              </SortableTh>
              <SortableTh
                active={sortKey === 'activity'} dir={sortDir} onClick={() => toggleSort('activity')}
                className="text-right"
              >
                {t('table.col.activity')}
              </SortableTh>
            </tr>
          </thead>
          <tbody>
            {pageRows.length === 0 ? (
              <tr>
                <td colSpan={7} className="px-4 py-12 text-center text-sm text-fg-muted">
                  {t('table.empty')}
                </td>
              </tr>
            ) : pageRows.map((r, i) => (
              <tr
                key={r.id}
                className={cn(
                  'transition-colors hover:bg-[color-mix(in_oklab,var(--brand-500)_5%,transparent)]',
                  i % 2 === 1 && 'bg-surface/40'
                )}
              >
                <Td>
                  <div className="flex items-center gap-3">
                    <Avatar className="size-8">
                      <AvatarImage src={r.avatar} alt={r.name} />
                      <AvatarFallback>{r.name.split(' ').map(s => s[0]).join('')}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0">
                      <div className="font-medium truncate">{r.name}</div>
                      <div className="text-xs text-fg-muted truncate">{r.email}</div>
                    </div>
                  </div>
                </Td>
                <Td className="text-fg-muted">{t(`role.${r.role}`)}</Td>
                <Td>
                  <Badge
                    size="sm"
                    variant={r.plan === 'team' ? 'brand' : r.plan === 'pro' ? 'solid' : 'neutral'}
                  >
                    {t(`radio.plan.${r.plan}`)}
                  </Badge>
                </Td>
                <Td>
                  <Badge
                    size="sm"
                    dot
                    variant={
                      r.status === 'active' ? 'success' :
                      r.status === 'invited' ? 'info' :
                      r.status === 'trial' ? 'warning' : 'danger'
                    }
                  >
                    {t(`status.${r.status}`)}
                  </Badge>
                </Td>
                <Td className="text-right font-mono text-xs">
                  {fmtMoney(r.mrr)}
                </Td>
                <Td className="text-fg-muted text-xs">
                  {format(r.signup, 'PP', { locale: dateLocale })}
                </Td>
                <Td className="text-right">
                  <ActivityBar value={r.activity} />
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex flex-wrap items-center gap-3 text-sm text-fg-muted">
          <span>{t('pagination.rowsPerPage')}</span>
          <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
            <SelectTrigger className="h-9 w-20">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {[5, 10, 25, 50].map((n) => (
                <SelectItem key={n} value={String(n)}>{n}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="font-mono text-xs">
            {t('pagination.itemsRange', { from: fromItem, to: toItem, total: sorted.length })}
          </span>
        </div>
        {totalPages > 1 ? (
          <Pagination className="lg:justify-end">
            <PaginationContent>
              <PaginationItem>
                <PaginationPrevious
                  showLabel={false}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                  aria-disabled={page === 1}
                  className={page === 1 ? 'pointer-events-none opacity-40' : ''}
                />
              </PaginationItem>
              {items.map((item, i) =>
                item === 'ellipsis' ? (
                  <PaginationItem key={`e-${i}`}>
                    <PaginationEllipsis />
                  </PaginationItem>
                ) : (
                  <PaginationItem key={item}>
                    <PaginationLink
                      isActive={page === item}
                      onClick={() => setPage(item)}
                    >
                      {item}
                    </PaginationLink>
                  </PaginationItem>
                )
              )}
              <PaginationItem>
                <PaginationNext
                  showLabel={false}
                  onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                  aria-disabled={page === totalPages}
                  className={page === totalPages ? 'pointer-events-none opacity-40' : ''}
                />
              </PaginationItem>
            </PaginationContent>
          </Pagination>
        ) : null}
      </div>
    </div>
  )
}

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th className={cn(
      'h-10 px-4 text-left text-[11px] font-semibold uppercase tracking-wider text-fg-muted',
      'border-b border-border whitespace-nowrap',
      className
    )}>
      {children}
    </th>
  )
}

function SortableTh({
  children,
  active,
  dir,
  onClick,
  className,
}: {
  children: React.ReactNode
  active: boolean
  dir: SortDir
  onClick: () => void
  className?: string
}) {
  return (
    <th className={cn(
      'h-10 px-0 text-left text-[11px] font-semibold uppercase tracking-wider text-fg-muted',
      'border-b border-border whitespace-nowrap',
      className
    )}>
      <button
        type="button"
        onClick={onClick}
        className={cn(
          'group inline-flex items-center gap-1.5 px-4 h-10 w-full text-left',
          'hover:text-fg transition-colors',
          active && 'text-fg',
          className?.includes('text-right') && 'justify-end'
        )}
      >
        {children}
        <span className={cn('size-3.5 transition-opacity', active ? 'opacity-100' : 'opacity-30 group-hover:opacity-70')}>
          {active ? (dir === 'asc' ? <ArrowUp className="size-3.5" /> : <ArrowDown className="size-3.5" />) : <ArrowUpDown className="size-3.5" />}
        </span>
      </button>
    </th>
  )
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <td className={cn('px-4 py-2.5 align-middle', className)}>
      {children}
    </td>
  )
}

function ActivityBar({ value }: { value: number }) {
  const color = value > 70 ? 'var(--success)' : value > 30 ? 'var(--brand-500)' : 'var(--fg-subtle)'
  return (
    <div className="inline-flex items-center gap-2 min-w-32">
      <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-surface-2">
        <div className="h-full rounded-full" style={{ width: `${value}%`, background: color }} />
      </div>
      <span className="text-xs font-mono text-fg-muted tabular-nums w-7 text-right">{value}</span>
    </div>
  )
}
