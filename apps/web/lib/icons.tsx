import type { ReactElement } from "react";

export const UNKNOWN_LABEL = "Unknown";

type IconProps = {
  title: string;
  colorClass: string;
  children: React.ReactNode;
};

// Color classes chosen so every icon clears WCAG AA (>= 4.5:1) against
// bg-background in both light and dark mode. Tailwind 600/700 tiers clear
// white; 300/400 tiers clear near-black. Palette tracks the hierarchy level:
//   level 1  CORE/IRR/VRR   violet
//   level 2  UPE            indigo
//   level 3  CSG/GPON/SW    blue
//   level 3.5 MW            cyan
//   level 4  RAN/PTP/PMP    teal
//   level 5  Customer       emerald
//   Unknown                 slate
const CORE_COLOR = "text-violet-700 dark:text-violet-300";
const AGG_COLOR = "text-indigo-700 dark:text-indigo-300";
const CAGG_COLOR = "text-blue-700 dark:text-blue-300";
const MW_COLOR = "text-cyan-700 dark:text-cyan-300";
const ACCESS_COLOR = "text-teal-700 dark:text-teal-300";
const CUSTOMER_COLOR = "text-emerald-700 dark:text-emerald-300";
const UNKNOWN_COLOR = "text-slate-700 dark:text-slate-300";

function Svg({ title, colorClass, children }: IconProps): ReactElement {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      width="24"
      height="24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={colorClass}
      role="img"
      aria-label={title}
    >
      <title>{title}</title>
      {children}
    </svg>
  );
}

const hexPath = "M12 2.5 L21 7 V17 L12 21.5 L3 17 V7 Z";

// Level 1 — Core routers
const CoreIcon: ReactElement = (
  <Svg title="Core" colorClass={CORE_COLOR}>
    <path d={hexPath} />
    <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
  </Svg>
);

const IrrIcon: ReactElement = (
  <Svg title="Internet Route Reflector" colorClass={CORE_COLOR}>
    <path d={hexPath} />
    <path d="M8 10 l3 2 -3 2" />
    <path d="M13 10 l3 2 -3 2" />
  </Svg>
);

const VrrIcon: ReactElement = (
  <Svg title="VPN Route Reflector" colorClass={CORE_COLOR}>
    <path d={hexPath} />
    <path d="M8 9 l4 7 4 -7" />
  </Svg>
);

// Level 2 — Aggregation
const UpeIcon: ReactElement = (
  <Svg title="Aggregation (UPE)" colorClass={AGG_COLOR}>
    <rect x="3.5" y="5" width="17" height="4" rx="1" />
    <rect x="3.5" y="11" width="17" height="4" rx="1" />
    <rect x="3.5" y="17" width="17" height="3" rx="1" />
    <circle cx="7" cy="7" r="0.6" fill="currentColor" stroke="none" />
    <circle cx="7" cy="13" r="0.6" fill="currentColor" stroke="none" />
  </Svg>
);

// Level 3 — CustomerAggregation
const CsgIcon: ReactElement = (
  <Svg title="Cell-Site Gateway" colorClass={CAGG_COLOR}>
    <rect x="3.5" y="7" width="17" height="10" rx="1.5" />
    <path d="M7 11h2M11 11h2M15 11h2M7 14h2M11 14h2M15 14h2" />
  </Svg>
);

const GponIcon: ReactElement = (
  <Svg title="GPON" colorClass={CAGG_COLOR}>
    <circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" />
    <path d="M6.5 12 H11" />
    <path d="M11 12 L19 5.5" />
    <path d="M11 12 L19 12" />
    <path d="M11 12 L19 18.5" />
    <circle cx="19.5" cy="5.5" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="19.5" cy="12" r="1.2" fill="currentColor" stroke="none" />
    <circle cx="19.5" cy="18.5" r="1.2" fill="currentColor" stroke="none" />
  </Svg>
);

const SwIcon: ReactElement = (
  <Svg title="Switch" colorClass={CAGG_COLOR}>
    <rect x="3" y="8.5" width="18" height="7" rx="1.2" />
    <path d="M7 6 v2.5 M12 6 v2.5 M17 6 v2.5" />
    <path d="M7 15.5 v2.5 M12 15.5 v2.5 M17 15.5 v2.5" />
  </Svg>
);

// Level 3.5 — Transport
const MwIcon: ReactElement = (
  <Svg title="Microwave" colorClass={MW_COLOR}>
    <path d="M12 3 v18" />
    <path d="M12 6 A6 6 0 0 1 18 12" />
    <path d="M12 9 A3 3 0 0 1 15 12" />
    <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
  </Svg>
);

// Level 4 — Access
const RanIcon: ReactElement = (
  <Svg title="RAN" colorClass={ACCESS_COLOR}>
    <path d="M12 8 v12" />
    <path d="M8 20 l4 -12 4 12" />
    <path d="M9.5 6.5 A3 3 0 0 1 14.5 6.5" />
    <path d="M7 4.5 A6 6 0 0 1 17 4.5" />
    <circle cx="12" cy="8" r="0.9" fill="currentColor" stroke="none" />
  </Svg>
);

const PtpIcon: ReactElement = (
  <Svg title="Point-to-Point" colorClass={ACCESS_COLOR}>
    <path d="M5 5 v14" />
    <path d="M19 5 v14" />
    <path d="M5 8 q3 4 0 8" />
    <path d="M19 8 q-3 4 0 8" />
    <path d="M7 12 H17" strokeDasharray="1.5 1.5" />
  </Svg>
);

const PmpIcon: ReactElement = (
  <Svg title="Point-to-Multipoint" colorClass={ACCESS_COLOR}>
    <path d="M12 4 v16" />
    <path d="M10 8 q4 4 0 8" />
    <path d="M14 8 q-4 4 0 8" />
    <path d="M4 6 l6 6 -6 6" />
    <path d="M20 6 l-6 6 6 6" />
  </Svg>
);

// Level 5 — Customer
const CustomerIcon: ReactElement = (
  <Svg title="Customer" colorClass={CUSTOMER_COLOR}>
    <path d="M4 11 L12 4 L20 11" />
    <path d="M6 10 V20 H18 V10" />
    <rect x="10" y="13" width="4" height="7" />
  </Svg>
);

// Unknown fallback
const UnknownIcon: ReactElement = (
  <Svg title="Unknown" colorClass={UNKNOWN_COLOR}>
    <circle cx="12" cy="12" r="9" />
    <path d="M9 9.5 A3 2.5 0 0 1 14.5 9.5 C14.5 12 12 11.5 12 14" />
    <circle cx="12" cy="17" r="0.9" fill="currentColor" stroke="none" />
  </Svg>
);

export const ROLE_ICONS: Record<string, ReactElement> = {
  CORE: CoreIcon,
  IRR: IrrIcon,
  VRR: VrrIcon,
  UPE: UpeIcon,
  CSG: CsgIcon,
  GPON: GponIcon,
  SW: SwIcon,
  MW: MwIcon,
  RAN: RanIcon,
  PTP: PtpIcon,
  PMP: PmpIcon,
  Customer: CustomerIcon,
  [UNKNOWN_LABEL]: UnknownIcon,
};

const LOOKUP: Record<string, ReactElement> = Object.fromEntries(
  Object.entries(ROLE_ICONS).map(([k, v]) => [k.toLowerCase(), v]),
);

export function iconFor(role: string | null | undefined): ReactElement {
  if (!role) return UnknownIcon;
  return LOOKUP[role.toLowerCase()] ?? UnknownIcon;
}

export const ALL_ROLES: string[] = Object.keys(ROLE_ICONS);
