/**
 * Ax Styler — drop-in source entry. Use this if you copied the `source/` directory
 * into your project (e.g. as `src/components/ax-styler/`). Imports below assume
 * the standard layout — adjust the relative paths if you flatten things.
 */

export { cn } from './utils'
export { ThemeProvider, useTheme } from './theme'
export type { Theme } from './theme'
export { I18nProvider, useI18n, LOCALES, LOCALE_LABELS } from './i18n'
export type { Locale } from './i18n'

export { Button, buttonVariants } from './button'
export type { ButtonProps } from './button'
export { Input } from './input'
export type { InputProps } from './input'
export { Textarea } from './textarea'
export type { TextareaProps } from './textarea'
export { Label } from './label'
export { Badge, badgeVariants } from './badge'
export type { BadgeProps } from './badge'
export { Avatar, AvatarImage, AvatarFallback } from './avatar'
export {
  Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter,
} from './card'
export { Switch } from './switch'
export { Checkbox } from './checkbox'
export { RadioGroup, RadioGroupItem } from './radio-group'
export {
  Select, SelectGroup, SelectValue, SelectTrigger, SelectContent, SelectLabel,
  SelectItem, SelectSeparator, SelectScrollUpButton, SelectScrollDownButton,
} from './select'

export {
  Dialog, DialogTrigger, DialogPortal, DialogClose, DialogOverlay,
  DialogContent, DialogHeader, DialogFooter, DialogTitle, DialogDescription,
} from './dialog'
export {
  Drawer, DrawerTrigger, DrawerClose, DrawerPortal,
  DrawerContent, DrawerHeader, DrawerFooter, DrawerTitle, DrawerDescription,
} from './drawer'
export {
  Tooltip, TooltipProvider, TooltipTrigger, TooltipContent,
} from './tooltip'
export { Tabs, TabsList, TabsTrigger, TabsContent } from './tabs'
export {
  DropdownMenu, DropdownMenuTrigger, DropdownMenuGroup, DropdownMenuPortal,
  DropdownMenuSub, DropdownMenuRadioGroup, DropdownMenuSubTrigger, DropdownMenuSubContent,
  DropdownMenuContent, DropdownMenuItem, DropdownMenuCheckboxItem, DropdownMenuRadioItem,
  DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuShortcut,
} from './dropdown-menu'
export {
  Popover, PopoverTrigger, PopoverAnchor, PopoverClose, PopoverContent,
} from './popover'

export {
  Table, TableHeader, TableBody, TableRow, TableHead, TableCell,
} from './table'

export { Calendar, getDateLocale } from './calendar'
export { DatePicker, defaultDatePresets } from './date-picker'
export type { DatePickerProps, DatePreset } from './date-picker'
export { DateRangePicker, defaultDateRangePresets } from './date-range-picker'
export type { DateRangePickerProps, DateRangePreset } from './date-range-picker'

export {
  Breadcrumb, BreadcrumbList, BreadcrumbItem, BreadcrumbLink, BreadcrumbPage,
  BreadcrumbSeparator, BreadcrumbSeparatorSlash, BreadcrumbEllipsis,
} from './breadcrumb'

export { Toaster } from './toaster'
export { ThemeToggle } from './theme-toggle'
export { LangSwitcher } from './lang-switcher'
