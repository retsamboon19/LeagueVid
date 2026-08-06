interface LeagueVidMarkProps {
  className?: string
}

/**
 * The shared LeagueVid mark. It stays as inline SVG in the renderer so the
 * header remains sharp at every display scale, while resources/icon.svg uses
 * the same geometry for Windows and the tray.
 */
export function LeagueVidMark({ className }: LeagueVidMarkProps): JSX.Element {
  return (
    <svg
      className={className}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
    >
      <rect x="2" y="2" width="60" height="60" rx="13" className="brand-mark-bg" />
      <path d="M6 10h11.3v34.3l8.2-4.5L33.3 54H6z" className="brand-mark-l" />
      <path
        d="M20.3 22.4h12.6l7 14 6.9-14H58L41.5 54h-3.3l-9-16.3 5.3-3.3-11.6-6.9z"
        className="brand-mark-v"
      />
      <path d="M17.25 21.5 34.55 34.45 17.25 45z" className="brand-mark-play" />
    </svg>
  )
}

/** The full header lockup: compact mark plus a readable wordmark. */
export default function LeagueVidLogo(): JSX.Element {
  return (
    <span className="brand-lockup">
      <LeagueVidMark className="brand-lockup-icon" />
      <h1 className="brand-wordmark">
        <span className="brand-wordmark-league">League</span>
        <span className="brand-wordmark-vid">Vid</span>
      </h1>
    </span>
  )
}
