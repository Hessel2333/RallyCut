import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";

type Action = {
  label: string;
  select: () => void;
  disabled?: boolean;
  shortcut?: string;
  group?: string;
};

export function EditorMenu({
  label,
  actions,
  icon,
  children,
}: {
  label: string;
  actions: Action[];
  icon?: ReactNode;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!open || !trigger.current || !menu.current) return;
    const rect = trigger.current.getBoundingClientRect();
    const height = menu.current.getBoundingClientRect().height;
    setPosition({
      left: Math.max(8, Math.min(window.innerWidth - 248, rect.right - 240)),
      top:
        rect.bottom + height + 8 <= window.innerHeight
          ? rect.bottom + 6
          : Math.max(8, rect.top - height - 6),
    });
    menu.current
      .querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (
        !menu.current?.contains(event.target as Node) &&
        !trigger.current?.contains(event.target as Node)
      )
        setOpen(false);
    };
    const close = () => setOpen(false);
    document.addEventListener("pointerdown", outside);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      window.removeEventListener("resize", close);
      window.removeEventListener("blur", close);
    };
  }, [open]);
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className="editor-menu-trigger"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ")
            event.stopPropagation();
          if (event.key === "ArrowDown") {
            event.preventDefault();
            event.stopPropagation();
            setOpen(true);
          }
        }}
      >
        {icon ?? <MoreHorizontal size={17} />}
      </button>
      {open &&
        createPortal(
          <div
            ref={menu}
            className="editor-popup"
            role="menu"
            aria-label={label}
            style={position}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setOpen(false);
                trigger.current?.focus();
              } else if (event.key === "Tab") setOpen(false);
              else if (
                ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) &&
                !(event.target as HTMLElement).closest("input")
              ) {
                event.preventDefault();
                event.stopPropagation();
                const buttons = [
                  ...menu.current!.querySelectorAll<HTMLButtonElement>(
                    "button:not(:disabled)",
                  ),
                ];
                const index = buttons.indexOf(
                  document.activeElement as HTMLButtonElement,
                );
                const next =
                  event.key === "Home"
                    ? 0
                    : event.key === "End"
                      ? buttons.length - 1
                      : (index +
                          (event.key === "ArrowDown" ? 1 : -1) +
                          buttons.length) %
                        buttons.length;
                buttons[next]?.focus();
              }
            }}
          >
            {children}
            {actions.map((action, index) => (
              <div key={action.label}>
                {action.group && action.group !== actions[index - 1]?.group && (
                  <div className="editor-menu-group">{action.group}</div>
                )}
                <button
                  role="menuitem"
                  type="button"
                  disabled={action.disabled}
                  onClick={() => {
                    setOpen(false);
                    trigger.current?.focus();
                    action.select();
                  }}
                >
                  <span>{action.label}</span>
                  {action.shortcut && <kbd>{action.shortcut}</kbd>}
                </button>
              </div>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}
