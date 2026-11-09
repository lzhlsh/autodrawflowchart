/**
 * Inline SVG icon set.
 *
 * Hand-rolled rather than pulling an icon library: it keeps the bundle small and
 * every glyph shares one stroke style, which is what makes the UI feel designed.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

const base = {
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.8,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
};

export const IconLogo = (p: IconProps) => (
  <svg {...base} {...p}>
    <rect x="3" y="3" width="7" height="5" rx="1.4" />
    <rect x="14" y="3" width="7" height="5" rx="1.4" />
    <rect x="8.5" y="16" width="7" height="5" rx="1.4" />
    <path d="M6.5 8v3.5h11V8" />
    <path d="M12 11.5V16" />
  </svg>
);

export const IconSparkles = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12 3l1.6 4.3L18 9l-4.4 1.7L12 15l-1.6-4.3L6 9l4.4-1.7L12 3z" />
    <path d="M18.5 15.5l.7 1.8 1.8.7-1.8.7-.7 1.8-.7-1.8-1.8-.7 1.8-.7.7-1.8z" />
    <path d="M5 14l.6 1.6L7.2 16l-1.6.6L5 18.2l-.6-1.6L2.8 16l1.6-.4L5 14z" />
  </svg>
);

export const IconSend = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4.5 12h13" />
    <path d="M12.5 6.5L18.5 12l-6 5.5" />
  </svg>
);

export const IconSettings = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 00.3 1.9l.1.1a2 2 0 11-2.8 2.8l-.1-.1a1.7 1.7 0 00-1.9-.3 1.7 1.7 0 00-1 1.5V21a2 2 0 11-4 0v-.1A1.7 1.7 0 008.9 19a1.7 1.7 0 00-1.9.3l-.1.1a2 2 0 11-2.8-2.8l.1-.1a1.7 1.7 0 00.3-1.9 1.7 1.7 0 00-1.5-1H3a2 2 0 110-4h.1A1.7 1.7 0 004.6 8.5a1.7 1.7 0 00-.3-1.9l-.1-.1a2 2 0 112.8-2.8l.1.1a1.7 1.7 0 001.9.3H9a1.7 1.7 0 001-1.5V3a2 2 0 114 0v.1a1.7 1.7 0 001 1.5 1.7 1.7 0 001.9-.3l.1-.1a2 2 0 112.8 2.8l-.1.1a1.7 1.7 0 00-.3 1.9V9a1.7 1.7 0 001.5 1H21a2 2 0 110 4h-.1a1.7 1.7 0 00-1.5 1z" />
  </svg>
);

export const IconDownload = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12 3v12" />
    <path d="M7.5 10.5L12 15l4.5-4.5" />
    <path d="M4 17.5V19a2 2 0 002 2h12a2 2 0 002-2v-1.5" />
  </svg>
);

export const IconRefresh = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M20 11.5a8 8 0 10-2.6 6.1" />
    <path d="M20 5v6h-6" />
  </svg>
);

export const IconTrash = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4 7h16" />
    <path d="M9.5 7V5.5A1.5 1.5 0 0111 4h2a1.5 1.5 0 011.5 1.5V7" />
    <path d="M6.5 7l.8 12.1A2 2 0 009.3 21h5.4a2 2 0 002-1.9L17.5 7" />
    <path d="M10.5 11v6M13.5 11v6" />
  </svg>
);

export const IconClose = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M6 6l12 12M18 6L6 18" />
  </svg>
);

export const IconZoomIn = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.5 15.5L21 21" />
    <path d="M10.5 8v5M8 10.5h5" />
  </svg>
);

export const IconZoomOut = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="10.5" cy="10.5" r="6.5" />
    <path d="M15.5 15.5L21 21" />
    <path d="M8 10.5h5" />
  </svg>
);

export const IconFit = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4 9V5.5A1.5 1.5 0 015.5 4H9" />
    <path d="M15 4h3.5A1.5 1.5 0 0120 5.5V9" />
    <path d="M20 15v3.5a1.5 1.5 0 01-1.5 1.5H15" />
    <path d="M9 20H5.5A1.5 1.5 0 014 18.5V15" />
  </svg>
);

export const IconGrid = (p: IconProps) => (
  <svg {...base} {...p}>
    <rect x="3.5" y="3.5" width="7" height="7" rx="1.3" />
    <rect x="13.5" y="3.5" width="7" height="7" rx="1.3" />
    <rect x="3.5" y="13.5" width="7" height="7" rx="1.3" />
    <rect x="13.5" y="13.5" width="7" height="7" rx="1.3" />
  </svg>
);

export const IconLayers = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12 3l8.5 4.5L12 12 3.5 7.5 12 3z" />
    <path d="M3.5 12.5L12 17l8.5-4.5" />
    <path d="M3.5 16.8L12 21.3l8.5-4.5" />
  </svg>
);

export const IconCheck = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

export const IconAlert = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12 3.8L21 19H3l9-15.2z" />
    <path d="M12 9.5v4" />
    <circle cx="12" cy="16.4" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

export const IconInfo = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="12" cy="12" r="9" />
    <path d="M12 10.8V16.5" />
    <circle cx="12" cy="7.8" r="0.9" fill="currentColor" stroke="none" />
  </svg>
);

export const IconCopy = (p: IconProps) => (
  <svg {...base} {...p}>
    <rect x="9" y="9" width="11.5" height="11.5" rx="2" />
    <path d="M15 6.5V5.5A2 2 0 0013 3.5H5.5a2 2 0 00-2 2V13a2 2 0 002 2h1" />
  </svg>
);

export const IconImage = (p: IconProps) => (
  <svg {...base} {...p}>
    <rect x="3" y="4.5" width="18" height="15" rx="2.2" />
    <circle cx="8.5" cy="10" r="1.6" />
    <path d="M4 17l4.5-4.5 3.5 3.5 3-3L20 17.5" />
  </svg>
);

export const IconCode = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M9 7l-5 5 5 5" />
    <path d="M15 7l5 5-5 5" />
  </svg>
);

export const IconChat = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M20.5 12.5a7.5 7.5 0 01-8 7.5 8.9 8.9 0 01-2.6-.4L5 21.5l1.4-4a7.4 7.4 0 01-1.9-5A7.5 7.5 0 0112.5 5a7.5 7.5 0 018 7.5z" />
  </svg>
);

export const IconBolt = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M13.5 3L5.5 13.5H11L10 21l8.5-10.8H13l.5-7.2z" />
  </svg>
);

export const IconEye = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M2.5 12S6 6.5 12 6.5 21.5 12 21.5 12 18 17.5 12 17.5 2.5 12 2.5 12z" />
    <circle cx="12" cy="12" r="3" />
  </svg>
);

export const IconKey = (p: IconProps) => (
  <svg {...base} {...p}>
    <circle cx="8" cy="14" r="3.5" />
    <path d="M10.6 11.4L20 2" />
    <path d="M17 5l2.5 2.5" />
    <path d="M14.5 7.5L17 10" />
  </svg>
);

export const IconUndo = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M4 9h10.5a5 5 0 110 10H8" />
    <path d="M7.5 5.5L4 9l3.5 3.5" />
  </svg>
);

export const IconPlus = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const IconHistory = (p: IconProps) => (
  <svg {...base} {...p}>
    <path d="M3.5 12a8.5 8.5 0 108.5-8.5A8.5 8.5 0 004 8" />
    <path d="M3.5 4v4.5H8" />
    <path d="M12 8v4.5l3 1.8" />
  </svg>
);
