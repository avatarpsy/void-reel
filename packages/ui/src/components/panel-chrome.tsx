import * as React from "react"
import {
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PanelsTopLeft,
} from "lucide-react"

import { cn } from "@openreel/ui/lib/utils"

/**
 * PANEL CHROME (React) — the collapse control, the rail it collapses to, and
 * the header row that carries it.
 *
 * The rule these implement is written down once, in
 * `@openreel/asset-browser/src/panel-chrome.ts`. Read that first: it explains
 * why the control lives in the panel rather than the toolbar, why collapsing
 * never unmounts, and why the icon is directional.
 *
 * This file deliberately does NOT import that module. `@openreel/ui` is a leaf
 * package with no workspace dependencies, and giving it one to fetch two
 * constants would mean re-linking the workspace for a number and an icon name.
 * The board (plain DOM) reads them from there, React reads them from here, and
 * `packages/asset-browser/src/panel-chrome.test.ts` reads BOTH files and fails
 * if they stop agreeing. The duplication is pinned, not hoped about.
 */

/** Keep in step with PANEL_RAIL_PX in @openreel/asset-browser/panel-chrome. */
export const PANEL_RAIL_PX = 44

export type PanelSide = "left" | "right"

const GLYPH = {
  "left-close": PanelLeftClose,
  "left-open": PanelLeftOpen,
  "right-close": PanelRightClose,
  "right-open": PanelRightOpen,
} as const

export interface PanelCollapseButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "onToggle" | "title"> {
  /** Which edge the panel is docked to — decides which way the chevron points. */
  side: PanelSide
  /** Current state. The button shows the action, not the state. */
  collapsed: boolean
  /** What the panel is called, for the tooltip: "Hide Assets" / "Show Assets". */
  name: string
  onToggle: () => void
}

/**
 * The one collapse button, everywhere.
 *
 * 28px square, ghost, 6px radius — small enough to sit in a header row beside
 * an "Add" or a search box without competing with them, large enough to hit.
 * Colour comes from the shared `text-*` / `background-*` tokens both editor
 * apps define identically, so this renders the same in the video editor and the
 * image editor with no per-app class list.
 */
export const PanelCollapseButton = React.forwardRef<
  HTMLButtonElement,
  PanelCollapseButtonProps
>(({ side, collapsed, name, onToggle, className, ...props }, ref) => {
  const Icon = GLYPH[`${side}-${collapsed ? "open" : "close"}` as const]
  const label = `${collapsed ? "Show" : "Hide"} ${name}`
  return (
    <button
      ref={ref}
      type="button"
      onClick={onToggle}
      title={label}
      aria-label={label}
      aria-expanded={!collapsed}
      className={cn(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md",
        "text-text-muted transition-colors",
        "hover:text-text-primary hover:bg-background-elevated",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
        className,
      )}
      {...props}
    >
      <Icon size={16} />
    </button>
  )
})
PanelCollapseButton.displayName = "PanelCollapseButton"

export interface AllPanelsButtonProps
  extends Omit<React.ButtonHTMLAttributes<HTMLButtonElement>, "title"> {
  /** True while at least one panel is open — the button offers to hide them. */
  anyOpen: boolean
  onToggle: () => void
}

/**
 * "Get everything out of the way" — the toolbar's one panel control.
 *
 * Per-panel collapse lives on each panel; this is the shortcut for the whole
 * set, and it is the ONLY panel control that belongs in a toolbar, because it
 * belongs to no single panel. Mirrors the Tab key, and says so.
 */
export const AllPanelsButton = React.forwardRef<HTMLButtonElement, AllPanelsButtonProps>(
  ({ anyOpen, onToggle, className, ...props }, ref) => {
    const label = anyOpen ? "Hide all panels (Tab)" : "Show all panels (Tab)"
    return (
      <button
        ref={ref}
        type="button"
        onClick={onToggle}
        title={label}
        aria-label={label}
        aria-pressed={!anyOpen}
        className={cn(
          "inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-lg transition-colors",
          anyOpen
            ? "text-text-secondary hover:text-text-primary hover:bg-background-elevated"
            : "bg-primary/15 text-primary",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60",
          className,
        )}
        {...props}
      >
        <PanelsTopLeft size={16} />
      </button>
    )
  },
)
AllPanelsButton.displayName = "AllPanelsButton"

export interface PanelHeaderProps {
  /** Shown at the leading edge. Also the word the collapse tooltip uses. */
  title: React.ReactNode
  /** The panel's name for the tooltip when `title` is not a plain string. */
  name?: string
  side: PanelSide
  collapsed: boolean
  onToggle: () => void
  /** Panel-specific actions. They sit between the title and the collapse
   *  button, which is always last. */
  children?: React.ReactNode
  className?: string
}

/**
 * A panel's top row: title, the panel's own actions, then collapse.
 *
 * The ORDER is the contract. Whatever a panel puts in `children`, the collapse
 * button is the last thing on the row — so the gesture is in the same place in
 * every editor, and muscle memory survives switching between them.
 */
export function PanelHeader({
  title,
  name,
  side,
  collapsed,
  onToggle,
  children,
  className,
}: PanelHeaderProps) {
  return (
    <div
      className={cn(
        "flex h-12 shrink-0 items-center gap-1 px-3",
        className,
      )}
    >
      <span className="min-w-0 flex-1 truncate text-sm font-bold tracking-tight text-text-primary">
        {title}
      </span>
      {children}
      <PanelCollapseButton
        side={side}
        collapsed={collapsed}
        name={name ?? (typeof title === "string" ? title : "panel")}
        onToggle={onToggle}
      />
    </div>
  )
}

export interface PanelRailProps {
  side: PanelSide
  /** Written down the rail so a collapsed panel still says what it is. */
  label: string
  onExpand: () => void
  className?: string
}

/**
 * What a collapsed panel becomes.
 *
 * NOT nothing. The image editor used to unmount its panels, which meant the
 * only route back was a toolbar button on the far side of the screen — you had
 * to already know it existed. A rail keeps the reopen gesture exactly where the
 * close gesture was, and the vertical label keeps the panel's identity on
 * screen, so the layout still reads as "three columns, one of them shut"
 * instead of "something is missing".
 */
export function PanelRail({ side, label, onExpand, className }: PanelRailProps) {
  return (
    <div
      style={{ width: PANEL_RAIL_PX }}
      className={cn(
        "flex h-full shrink-0 flex-col items-center gap-3 bg-background-secondary py-2.5",
        side === "left" ? "border-r border-border" : "border-l border-border",
        className,
      )}
    >
      <PanelCollapseButton side={side} collapsed name={label} onToggle={onExpand} />
      {/* Sideways title. Click-through to the same action so the whole rail is
          the target, not just the 28px button. */}
      <button
        type="button"
        onClick={onExpand}
        tabIndex={-1}
        aria-hidden="true"
        className="min-h-0 flex-1 cursor-pointer text-[11px] font-medium tracking-wide text-text-muted transition-colors hover:text-text-secondary"
        style={{ writingMode: "vertical-rl", textOrientation: "mixed" }}
      >
        {label}
      </button>
    </div>
  )
}
