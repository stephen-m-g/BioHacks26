// Small stroke icons (24px grid, currentColor). Decorative: pair them with visible text or aria-label.
const base = {
  width: 22,
  height: 22,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  'aria-hidden': true,
}

export const PenIcon = () => (
  <svg {...base}>
    <path d="M4 20l4-1 11-11-3-3L5 16l-1 4z" />
    <path d="M14 6l3 3" />
  </svg>
)

export const LassoIcon = () => (
  <svg {...base}>
    <path d="M6.5 16.5C4 15 3 13 3 11c0-4 4-7 9-7s9 3 9 7-4 7-9 7c-1.4 0-2.7-.2-3.9-.6" />
    <path d="M8 17c0 2-1 3-3 4" />
  </svg>
)

export const WandIcon = () => (
  <svg {...base}>
    <path d="M4 20L15 9" />
    <path d="M13.5 7.5l3 3" />
    <path d="M18 3v3M16.5 4.5h3M20 9v2M19 10h2M10 3v2M9 4h2" />
  </svg>
)

export const ChevronDownIcon = () => (
  <svg {...base} width={18} height={18}>
    <path d="M6 9l6 6 6-6" />
  </svg>
)

export const UndoIcon = () => (
  <svg {...base}>
    <path d="M9 14L4 9l5-5" />
    <path d="M4 9h11a5 5 0 010 10h-3" />
  </svg>
)

export const MicIcon = () => (
  <svg {...base}>
    <rect x="9" y="3" width="6" height="11" rx="3" />
    <path d="M5 11a7 7 0 0014 0M12 18v3" />
  </svg>
)

export const SwapIcon = () => (
  <svg {...base}>
    <path d="M7 7h13M16 3l4 4-4 4" />
    <path d="M17 17H4M8 13l-4 4 4 4" />
  </svg>
)

