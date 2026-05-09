import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'

/**
 * Merge tailwind classes with deduplication. Use everywhere instead of raw template strings
 * so that variants/overrides resolve predictably.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
