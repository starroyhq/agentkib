// Keep shared navigation styles together; shell selectors still handle platform layout.
export const navigationStyles = {
  appSidebarItem:
    "app-sidebar-item relative flex w-full min-h-10 items-center justify-start gap-3 rounded-[0.625rem] px-3 py-[0.5625rem] text-[color:color-mix(in_srgb,var(--sidebar-foreground)_74%,transparent)] text-[0.8125rem]! font-[520]! tracking-[0.005em] transition-[transform,translate,scale] duration-180 ease-[ease] hover:bg-[color-mix(in_srgb,var(--sidebar-accent)_68%,transparent)] hover:text-sidebar-accent-foreground active:translate-y-px active:scale-[0.99] focus-visible:outline-solid focus-visible:outline-2 focus-visible:outline-sidebar-ring focus-visible:outline-offset-2 motion-reduce:transition-none",
  appSidebarItemActive:
    "app-sidebar-item-active bg-sidebar-accent text-sidebar-accent-foreground font-semibold! hover:bg-sidebar-accent",
  appSidebarItemIcon:
    "app-sidebar-item-icon grid size-[1.125rem] flex-[0_0_1.125rem] place-items-center text-[color:color-mix(in_srgb,currentColor_82%,transparent)]",
  appToolbarContent:
    "app-toolbar-content flex w-full min-w-0 items-center justify-between gap-4 px-3 transition-[padding-left] duration-260 ease-[cubic-bezier(0.22,1,0.36,1)] [-webkit-app-region:no-drag] motion-reduce:transition-none",
  appToolbarBreadcrumb:
    "app-toolbar-breadcrumb flex min-w-0 self-stretch flex-auto items-center gap-1.5 text-[0.8125rem] font-[560] [-webkit-app-region:drag] [&>span]:flex [&>span]:min-w-0 [&>span]:items-center [&>span]:gap-1.5 [&_span_span]:truncate [&_em]:text-muted-foreground [&_em]:not-italic",
  appToolbarMore:
    "app-toolbar-more inline-flex min-h-8 w-8 items-center justify-center gap-2 border border-border rounded-[0.625rem] bg-muted text-muted-foreground pointer-events-auto [-webkit-app-region:no-drag]",
} as const;
