export function Logo({ size = 32 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" fill="none" aria-hidden>
      <rect width="32" height="32" rx="8" fill="url(#g)" />
      <circle cx="16" cy="16" r="3" fill="white" />
      <circle cx="9" cy="9" r="2" fill="white" opacity="0.9" />
      <circle cx="23" cy="9" r="2" fill="white" opacity="0.9" />
      <circle cx="9" cy="23" r="2" fill="white" opacity="0.9" />
      <circle cx="23" cy="23" r="2" fill="white" opacity="0.9" />
      <path d="M16 16 L9 9 M16 16 L23 9 M16 16 L9 23 M16 16 L23 23"
            stroke="white" strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="32" y2="32">
          <stop stopColor="#818cf8" />
          <stop offset="1" stopColor="#4f46e5" />
        </linearGradient>
      </defs>
    </svg>
  );
}
