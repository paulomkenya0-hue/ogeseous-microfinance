import type { SVGProps } from 'react'

type IconProps = SVGProps<SVGSVGElement>

const Svg = ({ children, ...props }: IconProps) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    className="h-5 w-5 shrink-0"
    {...props}
  >
    {children}
  </svg>
)

export const IconHome = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 10.5 12 4l8 6.5V20a1 1 0 0 1-1 1h-5v-6H10v6H5a1 1 0 0 1-1-1z" />
  </Svg>
)
export const IconUsers = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="8" r="3" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0" />
    <circle cx="17" cy="9" r="2.4" />
    <path d="M16 19a4.5 4.5 0 0 1 5-4.4" />
  </Svg>
)
export const IconClipboard = (p: IconProps) => (
  <Svg {...p}>
    <rect x="6" y="4" width="12" height="16" rx="2" />
    <path d="M9 4.5h6M9 10h6M9 14h4" />
  </Svg>
)
export const IconBank = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 10h16M6 10v8M10 10v8M14 10v8M18 10v8M3 18h18M12 4 4 10h16z" />
  </Svg>
)
export const IconWallet = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="6" width="18" height="13" rx="2" />
    <path d="M16 12h4v5h-4a2.5 2.5 0 0 1 0-5z" />
  </Svg>
)
export const IconAlert = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4 3 19h18z" />
    <path d="M12 10v4M12 16.5h.01" />
  </Svg>
)
export const IconChart = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 19h16M7 16v-5M12 16V8M17 16v-8" />
  </Svg>
)
export const IconMegaphone = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 10v4l12 4V6zM16 10a3 3 0 0 1 0 4M7 14v3a2 2 0 0 0 2 2h1" />
  </Svg>
)
export const IconShield = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3 5 6v6c0 4 3 6.5 7 8 4-1.5 7-4 7-8V6z" />
  </Svg>
)
export const IconCog = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M18.4 5.6 17 7M7 17l-1.4 1.4" />
  </Svg>
)
export const IconMenu = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 7h16M4 12h16M4 17h16" />
  </Svg>
)
export const IconClose = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
)
export const IconChevron = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 6 9 12l6 6" />
  </Svg>
)
export const IconArrowLeft = (p: IconProps) => (
  <Svg {...p}>
    <path d="M15 5 8 12l7 7" />
  </Svg>
)
export const IconArrowRight = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 5l7 7-7 7" />
  </Svg>
)
