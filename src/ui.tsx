import React, { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
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

/* ---------------- select ---------------- */
export interface SelectOption<T extends string | number | null> { value: T; label: string; sub?: string; group?: string }

/**
 * 替代原生 <select>：原生下拉在 WebView2 里是系统样式的方框列表，和毛玻璃风格不搭。
 * 菜单挂在 body 上（不被面板的滚动区域裁掉），放不下时向上弹出；
 * 键盘：Enter / 空格 / ↑↓ 打开，↑↓ 移动，Enter 选中，Esc / Tab 关闭，输入字符跳到以它开头的选项。
 */
export function Select<T extends string | number | null>({ value, options, onChange, label, placeholder = "请选择", className = "" }: {
  value: T; options: SelectOption<T>[]; onChange: (v: T) => void; label: string; placeholder?: string; className?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [pos, setPos] = useState<{ left: number; top: number; width: number; maxH: number; up: boolean; alignLeft: boolean } | null>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const typed = useRef({ s: "", t: 0 });
  const id = useId();
  const cur = options.findIndex((o) => o.value === value);
  const current = options[cur];

  const place = useCallback(() => {
    const r = btn.current?.getBoundingClientRect();
    if (!r) return;
    const width = Math.max(200, Math.min(300, r.width + 40));
    const below = window.innerHeight - r.bottom - 12, above = r.top - 76;
    const up = below < 220 && above > below;
    // 按钮在窗口左半边时菜单左对齐（如抢卡时段的卡型胶囊），否则右对齐（表单行右侧的值）
    const alignLeft = r.left + r.width / 2 < window.innerWidth / 2;
    const left = Math.min(Math.max(12, alignLeft ? r.left - 6 : r.right - width), window.innerWidth - width - 12);
    setPos({ left, width, up, alignLeft, top: up ? r.top - 6 : r.bottom + 6, maxH: Math.min(360, up ? above : below) });
  }, []);

  const show = (at = cur) => { place(); setActive(Math.max(0, at)); setOpen(true); };
  const close = (focus = true) => { setOpen(false); if (focus) btn.current?.focus(); };
  const pick = (i: number) => { const o = options[i]; if (o) onChange(o.value); close(); };

  useLayoutEffect(() => { if (open) menu.current?.focus(); }, [open]);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!menu.current?.contains(e.target as Node) && !btn.current?.contains(e.target as Node)) close(false);
    };
    // 窗口变化或外层滚动时直接收起，避免菜单和按钮错位。
    // 滚动事件在捕获阶段对任何元素都会触发，菜单自己滚动（滚轮、键盘选项 scrollIntoView）要排除，否则一滚就关
    const reflow = (e: Event) => {
      if (e.type === "scroll" && e.target instanceof Node && menu.current?.contains(e.target)) return;
      close(false);
    };
    window.addEventListener("pointerdown", away, true);
    window.addEventListener("resize", reflow);
    window.addEventListener("scroll", reflow, true);
    return () => {
      window.removeEventListener("pointerdown", away, true);
      window.removeEventListener("resize", reflow);
      window.removeEventListener("scroll", reflow, true);
    };
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (open) menu.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const jump = (ch: string) => {
    const now = Date.now();
    typed.current = { s: now - typed.current.t < 700 ? typed.current.s + ch : ch, t: now };
    const q = typed.current.s.toLowerCase();
    const i = options.findIndex((o) => o.label.toLowerCase().startsWith(q));
    if (i >= 0) setActive(i);
  };

  const onMenuKey = (e: React.KeyboardEvent) => {
    // 不让 Esc 等按键冒泡到外层（Sheet 在 window 上监听 Esc 关面板）
    e.stopPropagation();
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(options.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Home") { e.preventDefault(); setActive(0); }
    else if (e.key === "End") { e.preventDefault(); setActive(options.length - 1); }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); pick(active); }
    else if (e.key === "Escape") { e.preventDefault(); close(); }
    else if (e.key === "Tab") { close(); }
    else if (e.key.length === 1) jump(e.key);
  };

  return (
    <>
      <button ref={btn} type="button" className={`select-btn ${open ? "open" : ""} ${className}`}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? id : undefined} aria-label={`${label}：${current?.label ?? placeholder}`}
        onClick={() => (open ? close() : show())}
        onKeyDown={(e) => {
          if (["ArrowDown", "ArrowUp", "Enter", " "].includes(e.key)) { e.preventDefault(); e.stopPropagation(); show(); }
        }}>
        <span className={current ? "" : "muted"}>{current?.label ?? placeholder}</span>
        <Icon name="updown" size={14} stroke={2.2} className="select-caret" />
      </button>
      {createPortal(
        <AnimatePresence>
          {open && pos && (
            <motion.div ref={menu} id={id} role="listbox" aria-label={label} tabIndex={-1} className="select-menu"
              aria-activedescendant={`${id}-${active}`} onKeyDown={onMenuKey}
              style={{ left: pos.left, width: pos.width, maxHeight: pos.maxH, ...(pos.up ? { bottom: window.innerHeight - pos.top } : { top: pos.top }), transformOrigin: `${pos.up ? "bottom" : "top"} ${pos.alignLeft ? "left" : "right"}` }}
              initial={{ opacity: 0, scale: .96, y: pos.up ? 6 : -6 }} animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: .97, transition: { duration: .12 } }} transition={spring}>
              {options.map((o, i) => (
                <React.Fragment key={String(o.value)}>
                  {o.group && o.group !== options[i - 1]?.group && <div className="select-group" role="presentation">{o.group}</div>}
                  <div id={`${id}-${i}`} data-i={i} role="option" aria-selected={i === cur}
                    className={`select-opt ${i === active ? "active" : ""} ${i === cur ? "selected" : ""}`}
                    onPointerMove={() => setActive(i)} onClick={() => pick(i)}>
                    <span className="select-check">{i === cur && <Icon name="check" size={15} stroke={2.4} />}</span>
                    <span className="select-label">{o.label}{o.sub && <small>{o.sub}</small>}</span>
                  </div>
                </React.Fragment>
              ))}
            </motion.div>
          )}
        </AnimatePresence>,
        document.body,
      )}
    </>
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
