export function ComposerFastIcon({
  active,
  className = "size-3.5 shrink-0",
}: {
  active: boolean;
  className?: string;
}) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 24 24"
      fill={active ? "currentColor" : "none"}
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinejoin="round"
      className={className}
    >
      <path d="m14 2-10 12h7l-1 8 10-12h-7l1-8Z" />
    </svg>
  );
}
