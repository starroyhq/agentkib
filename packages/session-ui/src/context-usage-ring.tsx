export function ContextUsageRing({
  percent,
  unavailable = false,
}: {
  percent?: number;
  unavailable?: boolean;
}) {
  return (
    <svg
      className="size-4"
      viewBox="0 0 20 20"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.6"
      aria-hidden="true"
    >
      <circle cx="10" cy="10" r="7.5" opacity="0.25" />
      {!unavailable && percent === undefined && (
        <path d="M7.5 10h5" strokeLinecap="round" strokeWidth="2" opacity="0.5" />
      )}
      {percent !== undefined && percent > 0 && (
        <circle
          cx="10"
          cy="10"
          r="7.5"
          pathLength="100"
          strokeDasharray={`${percent} 100`}
          transform="rotate(-90 10 10)"
          opacity="1"
        />
      )}
    </svg>
  );
}
