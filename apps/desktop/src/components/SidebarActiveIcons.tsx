import { useId, type ReactNode } from "react";

type IconProps = { size?: number };

function SolidIcon({
  size = 20,
  shape,
  children,
}: IconProps & { shape: string; children?: ReactNode }) {
  const mask = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <defs>
        <mask id={mask} maskUnits="userSpaceOnUse" x="0" y="0" width="24" height="24">
          <path d={shape} fill="white" />
          <g
            fill="none"
            stroke="black"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            {children}
          </g>
        </mask>
      </defs>
      <path d={shape} mask={`url(#${mask})`} />
    </svg>
  );
}

export function HomeSolid(props: IconProps) {
  return (
    <SolidIcon
      {...props}
      shape="M10.7 2.4a2 2 0 0 1 2.6 0l7 6A2 2 0 0 1 21 10v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V10a2 2 0 0 1 .7-1.6z"
    >
      <path d="M9 22v-9h6v9Z" fill="black" stroke="none" />
    </SolidIcon>
  );
}

export function FolderGitSolid(props: IconProps) {
  return (
    <SolidIcon
      {...props}
      shape="M4 3h4.2a2 2 0 0 1 1.4.6L11 5h9a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Z"
    >
      <path d="M9 11v6m0-3h5a3 3 0 0 0 3-3" />
      <circle cx="9" cy="10" r="1.4" fill="black" stroke="none" />
      <circle cx="9" cy="18" r="1.4" fill="black" stroke="none" />
      <circle cx="17" cy="10" r="1.4" fill="black" stroke="none" />
    </SolidIcon>
  );
}

export function MessageSquareTextSolid(props: IconProps) {
  return (
    <SolidIcon {...props} shape="M5 2h14a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H7l-5 3V5a3 3 0 0 1 3-3Z">
      <path d="M7 7h10M7 11h10M7 15h6" />
    </SolidIcon>
  );
}

export function LibrarySolid(props: IconProps) {
  return (
    <SolidIcon
      {...props}
      shape="M3 3h3v18H3zm5 0h3v18H8zm5 0h3v18h-3zm3.1.8 2.9-.6 4 17.4-2.9.6Z"
    />
  );
}

export function GaugeSolid(props: IconProps) {
  return (
    <SolidIcon {...props} shape="M12 2a10 10 0 0 1 8.7 15l-2.9 5H6.2l-2.9-5A10 10 0 0 1 12 2Z">
      <path d="M12 5v1M5.9 8l.7.7m10.8-.7-.7.7M5 14h1m12 0h1m-7 2 4-5" />
      <circle cx="12" cy="16" r="1.5" fill="black" stroke="none" />
    </SolidIcon>
  );
}

export function AwardSolid(props: IconProps) {
  return (
    <SolidIcon
      {...props}
      shape="M18 8a6 6 0 1 1-12 0 6 6 0 0 1 12 0Zm-11 4-3 10 5-2 3 3 2-10Zm6 1 2 10 3-3 4 2-4-10Z"
    >
      <circle cx="12" cy="8" r="3.1" />
    </SolidIcon>
  );
}

export function SettingsSolid(props: IconProps) {
  return (
    <SolidIcon
      {...props}
      shape="M9 2h6l.6 3a8 8 0 0 1 1.4.8l2.9-1 3 5.2-2.3 2v1.6l2.3 2-3 5.2-2.9-1a8 8 0 0 1-1.4.8L15 23H9l-.6-3.4a8 8 0 0 1-1.4-.8l-2.9 1-3-5.2 2.3-2V11l-2.3-2 3-5.2 2.9 1A8 8 0 0 1 8.4 4Z"
    >
      <circle cx="12" cy="12" r="3.4" fill="black" stroke="none" />
    </SolidIcon>
  );
}
