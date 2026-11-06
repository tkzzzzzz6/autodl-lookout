import React, { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, animate, motion, useReducedMotion, type Variants } from "motion/react";
import { call, errText, type RefData } from "./api";
import { Icon, type IconName } from "./icons";

export const spring = { type: "spring", stiffness: 520, damping: 38, mass: 0.9 } as const;
export const softSpring = { type: "spring", stiffness: 260, damping: 30 } as const;

/* ---------------- toast ---------------- */
type ToastFn = (msg: string, err?: boolean) => void;
const ToastCtx = createContext<ToastFn>(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [t, setT] = useState<{ id: number; msg: string; err: boolean } | null>(null);
  const show = useCallback<ToastFn>((msg, err = false) => setT({ id: Date.now(), msg, err }), []);
  useEffect(() => {
    if (!t) return;
    const id = setTimeout(() => setT(null), t.err ? 6000 : 2400);
    return () => clearTimeout(id);
  }, [t]);
  return (
    <ToastCtx.Provider value={show}>
      {children}
      <AnimatePresence>
        {t && (
          <motion.div key={t.id} role="status" className={`toast ${t.err ? "err" : ""}`}
            initial={{ opacity: 0, y: 24, x: "-50%", scale: .96 }} animate={{ opacity: 1, y: 0, x: "-50%", scale: 1 }}
            exit={{ opacity: 0, y: 12, x: "-50%", scale: .98 }} transition={spring}>
            <span className="tile"><Icon name={t.err ? "x" : "check"} size={15} stroke={2.2} /></span>
            {t.msg}
          </motion.div>
        )}
      </AnimatePresence>
    </ToastCtx.Provider>
  );
}

/** 执行异步操作，失败弹错误提示 */
export function useAction() {
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, okMsg?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const r = await fn();
        if (okMsg) toast(okMsg);
        return r;
      } catch (e) {
        toast(errText(e), true);
      } finally {
        setBusy(false);
      }
    },
    [toast],
  );
  return { busy, run };
}

let refCache: Promise<RefData> | null = null;
export function useRefData(): RefData | null {
  const [d, setD] = useState<RefData | null>(null);
  useEffect(() => {
    refCache ??= call<RefData>("ref_data");
    refCache.then(setD);
  }, []);
  return d;
}

/* ---------------- primitives ---------------- */
export function Tile({ name, grey, badge, sm, size }: { name: IconName; grey?: boolean; badge?: boolean; sm?: boolean; size?: number }) {
  return (
    <span className={`tile ${grey ? "grey" : ""} ${sm ? "sm" : ""}`}>
      <Icon name={name} size={size ?? (sm ? 18 : 22)} stroke={1.8} />
      {badge && <span className="badge"><Icon name="bell_fill" size={12} stroke={1.6} /></span>}
    </span>
  );
}

export interface SegItem<T extends string> { id: T; label: string; icon?: IconName; badge?: number }
export function Segmented<T extends string>({ items, value, onChange, layoutId, small, full }: {
  items: SegItem<T>[]; value: T; onChange: (v: T) => void; layoutId: string; small?: boolean; full?: boolean;
}) {
  return (
    <div className={`segmented ${small ? "small" : ""} ${full ? "full" : ""}`} role="tablist">
      {items.map((it) => (
        <button key={it.id} role="tab" aria-selected={value === it.id} onClick={() => onChange(it.id)}>
          {value === it.id && <motion.span layoutId={layoutId} className="pill" transition={spring} />}
          {it.icon && <Icon name={it.icon} size={14} stroke={1.9} />}
          {it.label}
          {!!it.badge && <motion.span className="badge" initial={{ scale: 0 }} animate={{ scale: 1 }} transition={spring}>{it.badge}</motion.span>}
        </button>
      ))}
    </div>
  );
}

export function Switch({ checked, onChange, label }: { checked: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <motion.button type="button" role="switch" aria-checked={checked} aria-label={label} className="switch"
      onClick={(e) => { e.stopPropagation(); onChange(!checked); }} whileTap={{ scale: .94 }}>
      <motion.span className="knob" animate={{ x: checked ? 20 : 0 }} transition={spring} />
    </motion.button>
  );
}

export function Stepper({ value, onChange, min = 0, max = 999, step = 1, unit = "" }: {
  value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number; unit?: string;
}) {
  return (
    <span className="row" style={{ gap: 0, flexWrap: "nowrap" }}>
      <motion.span key={value} className="stepper-val" initial={{ y: -6, opacity: .4 }} animate={{ y: 0, opacity: 1 }} transition={spring}>
        {value}{unit && ` ${unit}`}
      </motion.span>
      <span className="stepper">
        <button type="button" aria-label="减少" disabled={value <= min} onClick={() => onChange(Math.max(min, value - step))}>−</button>
        <i />
        <button type="button" aria-label="增加" disabled={value >= max} onClick={() => onChange(Math.min(max, value + step))}>+</button>
      </span>
    </span>
  );
}

/** 数字变化时滚动过去 */
export function CountUp({ value, decimals = 0, className }: { value: number; decimals?: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const prev = useRef(value);
  const reduce = useReducedMotion();
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (reduce) { el.textContent = value.toFixed(decimals); prev.current = value; return; }
    const c = animate(prev.current, value, {
      duration: .7, ease: [.22, 1, .36, 1],
      onUpdate: (v) => { el.textContent = v.toFixed(decimals); },
    });
    prev.current = value;
    return () => c.stop();
  }, [value, decimals, reduce]);
  return <span ref={ref} className={className}>{value.toFixed(decimals)}</span>;
}

/* ---------------- grouped list ---------------- */
export function Group({ children, className = "", style }: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return <div className={`group glass ${className}`} style={style}>{children}</div>;
}

export function Row({ icon, grey, badge, label, dim, sub, value, right, chevron, onClick, selected, children }: {
  icon?: IconName; grey?: boolean; badge?: boolean; label?: ReactNode; dim?: boolean; sub?: ReactNode; value?: ReactNode;
  right?: ReactNode; chevron?: boolean; onClick?: () => void; selected?: boolean; children?: ReactNode;
}) {
  const inner = (
    <>
      {icon && <Tile name={icon} grey={grey} badge={badge} />}
      <div className="grow">
        {label != null && <div className={`label ${dim ? "dim" : ""}`}>{label}</div>}
        {sub != null && <div className="sub">{sub}</div>}
      </div>
      {children}
      {value != null && <span className="value">{value}</span>}
      {right}
      {chevron && <Icon name="chev" size={16} stroke={2} className="chev" />}
    </>
  );
  if (!onClick) return <div className={`group-row ${selected ? "selected" : ""}`}>{inner}</div>;
  return (
    <motion.div role="button" tabIndex={0} className={`group-row tappable ${selected ? "selected" : ""}`}
      onClick={onClick}
      onKeyDown={(e) => {
        // 行里的按钮、开关等自己处理键盘；只有焦点在行本身时才打开
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); onClick(); }
      }}
      whileTap={{ scale: .985 }} transition={spring}>
      {inner}
    </motion.div>
  );
}

/** 表单行：左侧图标+标签，右侧控件 */
export function FormRow({ icon, label, children }: { icon: IconName; label: string; children: ReactNode }) {
  return (
    <div className="group-row" style={{ cursor: "default" }}>
      <Tile name={icon} sm />
      <span className="label" style={{ flex: "none" }}>{label}</span>
      <span style={{ flex: 1, display: "flex", justifyContent: "flex-end", alignItems: "center", minWidth: 0 }}>{children}</span>
    </div>
  );
}

/* ---------------- sheet ---------------- */
export function Sheet({ open, onClose, title, left, right, children }: {
  open: boolean; onClose: () => void; title: ReactNode; left?: ReactNode; right?: ReactNode; children: ReactNode;
}) {
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open, onClose]);
  return (
    <AnimatePresence>
      {open && (
        <>
          <motion.div key="scrim" className="scrim" onClick={onClose}
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: .2 }} />
          <motion.aside key="sheet" className="sheet" role="dialog" aria-modal="true"
            initial={{ x: 480, opacity: .6 }} animate={{ x: 0, opacity: 1 }} exit={{ x: 480, opacity: .6 }} transition={softSpring}>
            <div className="sheet-head">
              <div>{left ?? <button className="link-btn" onClick={onClose}>取消</button>}</div>
              <h3>{title}</h3>
              <div>{right}</div>
            </div>
            <div className="sheet-body">{children}</div>
          </motion.aside>
        </>
      )}
    </AnimatePresence>
  );
}

/** 危险操作：点一次变成“再点一次确认”，3 秒内再点才执行 */
export function ConfirmButton({ label, confirmLabel, onConfirm, className = "btn danger", disabled, icon }: {
  label: string; confirmLabel?: string; onConfirm: () => void; className?: string; disabled?: boolean; icon?: IconName;
}) {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    if (!armed) return;
    const id = setTimeout(() => setArmed(false), 3000);
    return () => clearTimeout(id);
  }, [armed]);
  return (
    <motion.button className={className} disabled={disabled} whileTap={{ scale: .96 }} layout transition={spring}
      onClick={() => { if (armed) { setArmed(false); onConfirm(); } else setArmed(true); }}>
      {icon && <Icon name={icon} size={16} stroke={1.9} />}
      {armed ? confirmLabel ?? `再点一次${label}` : label}
    </motion.button>
  );
}

export function Btn({ icon, children, primary, small, onClick, disabled, className = "", spinning }: {
  icon?: IconName; children: ReactNode; primary?: boolean; small?: boolean; onClick?: () => void; disabled?: boolean;
  className?: string; spinning?: boolean;
}) {
  return (
    <motion.button className={`btn ${primary ? "primary" : ""} ${small ? "small" : ""} ${className}`} onClick={onClick}
      disabled={disabled} whileHover={disabled ? undefined : { y: -1 }} whileTap={disabled ? undefined : { scale: .96 }} transition={spring}>
      {icon && <Icon name={icon} size={small ? 15 : 17} stroke={2} className={spinning ? "spin" : ""} />}
      {children}
    </motion.button>
  );
}

export function Page({ children }: { children: ReactNode }) {
  return (
    <motion.div className="page" initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -6 }} transition={{ duration: .28, ease: [.22, 1, .36, 1] }}>
      {children}
    </motion.div>
  );
}

/** 列表项依次出现（只在首次挂载时） */
export const stagger: { container: Variants; item: Variants } = {
  container: { animate: { transition: { staggerChildren: .035 } } },
  item: { initial: { opacity: 0, y: 6 }, animate: { opacity: 1, y: 0, transition: { duration: .3, ease: [.22, 1, .36, 1] } } },
};

export const numOrNull = (s: string): number | null => (s.trim() === "" ? null : Number(s));

export async function copy(text: string) {
  await navigator.clipboard.writeText(text);
}
