import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { ChevronLeft, Keyboard, Layers } from "lucide-react";

/* Shared chrome for the two editing workspaces: top bar, resizable/collapsible panels, popovers and states. */

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
export const MOD = isMac ? "⌘" : "Ctrl";

export function Spinner({ size = "sm", label }: { size?: "sm" | "lg"; label?: string }) {
  return <span className={`spinner${size === "lg" ? " lg" : ""}`} role={label ? "status" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="kbd">{children}</kbd>;
}

export function BrandMark({ size = 16 }: { size?: number }) {
  return (
    <span className="brand-mark" aria-hidden="true">
      <Layers size={size} strokeWidth={2.2} />
    </span>
  );
}

export function EmptyState({
  icon,
  title,
  children,
  actions,
  tone,
}: {
  icon: ReactNode;
  title: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  tone?: "danger";
}) {
  return (
    <div className="empty-state">
      <span className={`empty-icon${tone ? ` ${tone}` : ""}`} aria-hidden="true">
        {icon}
      </span>
      <p className="empty-title">{title}</p>
      {children && <p>{children}</p>}
      {actions && <div className="actions">{actions}</div>}
    </div>
  );
}

export function WorkspaceTopBar({ back, title, meta, center, end }: { back: { to: string; label: string }; title: ReactNode; meta?: ReactNode; center?: ReactNode; end?: ReactNode }) {
  return (
    <header className="ws-topbar">
      <div className="ws-topbar-start">
        <Link to={back.to} className="ws-back" aria-label={`Back to ${back.label}`}>
          <ChevronLeft size={18} aria-hidden="true" />
          <span className="hide-md">{back.label}</span>
        </Link>
        <span className="ws-divider" aria-hidden="true" />
        <div className="ws-title">
          <h1>{title}</h1>
          {meta}
        </div>
      </div>
      <div className="ws-topbar-center">{center}</div>
      <div className="ws-topbar-end">{end}</div>
    </header>
  );
}

function readStored<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;
  }
}

function writeStored(key: string, value: unknown) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Storage can be unavailable (private mode, blocked site data); the layout just won't be remembered.
  }
}

/** A per-browser remembered value (panel widths, collapsed state). */
export function useStoredState<T>(key: string, fallback: T): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => readStored(key, fallback));
  const set = useCallback(
    (next: T) => {
      setValue(next);
      writeStored(key, next);
    },
    [key],
  );
  return [value, set];
}

/** Default panel width for the current window: a little narrower on laptop/tablet widths so the canvas keeps room. */
export function defaultPanelWidth(wide: number, narrow: number): number {
  return typeof window !== "undefined" && window.innerWidth < 1280 ? narrow : wide;
}

/** Drag handle on a panel's inner edge. Arrow keys resize too; double-click restores the default width. */
export function PanelResizer({
  side,
  width,
  min,
  max,
  onResize,
  onReset,
  label,
}: {
  side: "left" | "right";
  width: number;
  min: number;
  max: number;
  onResize: (width: number) => void;
  onReset: () => void;
  label: string;
}) {
  const start = useRef<{ x: number; width: number } | null>(null);
  const [active, setActive] = useState(false);
  const clamp = (w: number) => Math.round(Math.min(max, Math.max(min, w)));

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    start.current = { x: e.clientX, width };
    setActive(true);
    document.body.classList.add("is-resizing");
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (!start.current) return;
    const dx = e.clientX - start.current.x;
    onResize(clamp(start.current.width + (side === "left" ? dx : -dx)));
  };
  const end = () => {
    start.current = null;
    setActive(false);
    document.body.classList.remove("is-resizing");
  };
  const onKeyDown = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    const grow = side === "left" ? "ArrowRight" : "ArrowLeft";
    const shrink = side === "left" ? "ArrowLeft" : "ArrowRight";
    if (e.key === grow) onResize(clamp(width + step));
    else if (e.key === shrink) onResize(clamp(width - step));
    else return;
    e.preventDefault();
  };

  return (
    <div
      className={`panel-resizer${active ? " active" : ""}`}
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={width}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={end}
      onPointerCancel={end}
      onDoubleClick={onReset}
      onKeyDown={onKeyDown}
    />
  );
}

/** A side panel's width and collapsed state, remembered per browser. */
export function usePanel(key: string, wide: number, narrow: number) {
  const [fallback, setFallback] = useState(() => defaultPanelWidth(wide, narrow));
  // Until the user sizes a panel themselves, its default follows the window across the laptop/desktop breakpoint.
  useEffect(() => {
    const onResize = () => setFallback(defaultPanelWidth(wide, narrow));
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [wide, narrow]);
  const [stored, setStored] = useStoredState<number | null>(`psd-studio:panel:${key}:width`, null);
  const [collapsed, setCollapsed] = useStoredState(`psd-studio:panel:${key}:collapsed`, false);
  return {
    width: stored ?? fallback,
    setWidth: (w: number) => setStored(w),
    reset: () => setStored(null),
    collapsed,
    toggle: () => setCollapsed(!collapsed),
  };
}

/** Click-to-open popover anchored under its trigger; closes on outside click or Escape (without the page also seeing that Escape). */
export function Popover({
  trigger,
  children,
  align = "end",
  open: controlledOpen,
  onOpenChange,
  className = "",
}: {
  trigger: (props: { onClick: () => void; "aria-expanded": boolean; "aria-haspopup": "dialog" }) => ReactNode;
  children: ReactNode;
  align?: "start" | "end";
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  className?: string;
}) {
  const [innerOpen, setInnerOpen] = useState(false);
  const open = controlledOpen ?? innerOpen;
  const setOpen = useCallback((next: boolean) => (onOpenChange ? onOpenChange(next) : setInnerOpen(next)), [onOpenChange]);
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open, setOpen]);

  return (
    <span className="popover-anchor" ref={ref}>
      {trigger({ onClick: () => setOpen(!open), "aria-expanded": open, "aria-haspopup": "dialog" })}
      {open && (
        <div className={`popover${align === "start" ? " align-start" : ""} ${className}`} role="dialog">
          {children}
        </div>
      )}
    </span>
  );
}

export type Shortcut = readonly [action: string, keys: readonly string[]];

export function ShortcutsButton({ shortcuts }: { shortcuts: readonly Shortcut[] }) {
  return (
    <Popover
      trigger={(props) => (
        <button type="button" className="icon-btn" aria-label="Keyboard shortcuts" data-tip="Shortcuts & gestures" data-tip-align="end" {...props}>
          <Keyboard size={18} aria-hidden="true" />
        </button>
      )}
    >
      <p className="popover-title">Shortcuts &amp; gestures</p>
      <dl className="shortcut-list">
        {shortcuts.map(([action, keys]) => (
          <div key={action} style={{ display: "contents" }}>
            <dt>{action}</dt>
            <dd>
              {keys.map((k) => (
                <Kbd key={k}>{k}</Kbd>
              ))}
            </dd>
          </div>
        ))}
      </dl>
    </Popover>
  );
}

/** Canvas-first placeholder shown while a workspace's data loads, so the frame doesn't jump when it arrives. */
export function WorkspaceSkeleton({ right = true, label = "Loading workspace" }: { right?: boolean; label?: string }) {
  const rows = [70, 55, 82, 64, 48, 76];
  return (
    <div className="ws ws-skeleton" aria-busy="true">
      <header className="ws-topbar">
        <div className="ws-topbar-start">
          <span className="skeleton" style={{ width: 110, height: 16 }} />
          <span className="ws-divider" />
          <span className="skeleton" style={{ width: 160, height: 16 }} />
        </div>
        <div className="ws-topbar-center" />
        <div className="ws-topbar-end">
          <span className="skeleton" style={{ width: 96, height: 32 }} />
        </div>
      </header>
      <div className={`ws-body${right ? "" : " no-right"}`}>
        <aside className="panel left">
          <div className="panel-header">
            <span className="skeleton" style={{ width: 70, height: 12 }} />
          </div>
          <div className="panel-body">
            {rows.map((w, i) => (
              <div className="sk-row" key={i}>
                <span className="skeleton" style={{ width: 30, height: 24 }} />
                <span className="skeleton" style={{ width: `${w}%`, height: 12 }} />
              </div>
            ))}
          </div>
        </aside>
        <main className="ws-canvas">
          <div className="canvas-loading" role="status" aria-label={label}>
            <div className="artboard-ghost" />
            <span className="row" style={{ gap: 8 }}>
              <Spinner /> {label}…
            </span>
          </div>
        </main>
        {right && (
          <aside className="panel right">
            <div className="panel-header">
              <span className="skeleton" style={{ width: 90, height: 12 }} />
            </div>
            <div className="panel-body">
              {rows.slice(0, 3).map((w, i) => (
                <span key={i} className="skeleton" style={{ width: `${w}%`, height: 34 }} />
              ))}
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
