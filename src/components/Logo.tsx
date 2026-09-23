// Hexa Studio mark — inline SVG so it follows the icon exactly (design/hexa-icon.svg).

export function Logo({ size = 36, className }: { size?: number; className?: string }) {
  return (
    <svg
      viewBox="0 0 1024 1024"
      width={size}
      height={size}
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <linearGradient id="hx-bg" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#23204a" />
          <stop offset="1" stopColor="#0d0e15" />
        </linearGradient>
        <linearGradient id="hx-ring" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#a5b4fc" />
          <stop offset="0.55" stopColor="#6366f1" />
          <stop offset="1" stopColor="#7c3aed" />
        </linearGradient>
        <linearGradient id="hx-core" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#67e8f9" />
          <stop offset="1" stopColor="#6366f1" />
        </linearGradient>
      </defs>
      <rect width="1024" height="1024" rx="224" fill="url(#hx-bg)" />
      <path
        d="M512 162 L815 337 L815 687 L512 862 L209 687 L209 337 Z"
        fill="none"
        stroke="url(#hx-ring)"
        strokeWidth="64"
        strokeLinejoin="round"
      />
      <path d="M584 300 L744 392 L744 576 L584 668 L424 576 L424 392 Z" fill="#7c3aed" opacity="0.28" />
      <path d="M512 322 L677 417 L677 607 L512 702 L347 607 L347 417 Z" fill="url(#hx-core)" />
      <path d="M512 322 L677 417 L512 512 L347 417 Z" fill="#ffffff" opacity="0.18" />
    </svg>
  );
}
