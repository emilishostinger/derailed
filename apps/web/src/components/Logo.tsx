/**
 * The mark: track seen from above, with one rail leaving the others. The one place
 * this product allows itself a joke.
 *
 * The drawing is 395x427, so it is scaled to about 62% of the tile and centred rather
 * than stretched. Same geometry as the favicon, which is what makes the sidebar at
 * 18px and a home screen icon at 512px read as the same thing.
 */
export function Logo({ className = 'h-6 w-6' }: { className?: string }) {
  return (
    <svg viewBox="0 0 512 512" className={className} aria-hidden="true">
      <title>Derailed</title>
      <defs>
        <linearGradient id="derailed-mark" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ff9a3d" />
          <stop offset="100%" stopColor="#c4490c" />
        </linearGradient>
      </defs>
      <rect width="512" height="512" rx="112" fill="url(#derailed-mark)" />
      <g transform="translate(110 98) scale(0.742)" fill="#fff">
        <path d="M57 377H0V317H57V377ZM110 377H67V317H110V377ZM230.058 377H120V317H242.625L230.058 377ZM283.995 377H240.275L252.843 317H296.562L283.995 377ZM395 377H294.213L306.78 317H395V377ZM57 243H0V183H57V243ZM110 243H67V183H110V243ZM258.125 243H120V183H270.692L258.125 243ZM312.062 243H268.342L280.909 183H324.63L312.062 243ZM395 243H322.279L334.847 183H395V243ZM57 50V110H0V50H57ZM339.921 110H296.2L308.768 50H352.488L339.921 110ZM395 110H350.138L362.705 50H395V110ZM110 50V110H67V50H110ZM285.983 110H120V50H298.551L285.983 110Z" />
        <rect x="67" width="43" height="427" />
        <rect
          x="319.225"
          y="0.126945"
          width="43"
          height="427"
          transform="rotate(11.8298 319.225 0.126945)"
        />
      </g>
    </svg>
  );
}

export function Wordmark() {
  return (
    <span className="flex items-center gap-2 text-[14px] font-semibold tracking-[-0.02em] text-ink">
      <Logo className="h-[18px] w-[18px]" />
      Derailed
    </span>
  );
}
