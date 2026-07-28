import { MOTION_EASE } from "../lib/motion";
import { motion, useReducedMotion } from "framer-motion";

// One surface, not three. This used to be a bordered card wrapping a bordered
// header bar wrapping an icon plate.
export default function OperatorPane({
  title,
  icon: Icon,
  right,
  testId,
  children,
  className = "",
}) {
  const reduceMotion = useReducedMotion();
  return (
    <motion.section
      data-testid={testId}
      layout={!reduceMotion}
      initial={reduceMotion ? false : { opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: reduceMotion ? 0 : 0.22, ease: MOTION_EASE }}
      className={`min-w-0 overflow-hidden rounded-[var(--radius-panel)] border ${className}`}
      style={{
        borderColor: "var(--border-subtle)",
        background: "color-mix(in srgb, var(--bg-panel) 72%, transparent)",
      }}
    >
      <div
        className="flex min-h-9 items-center justify-between gap-3 border-b px-3 py-2"
        style={{ borderColor: "var(--border-subtle)" }}
      >
        <span
          className="flex min-w-0 items-center gap-1.5 text-[10px] font-semibold uppercase tracking-[0.08em]"
          style={{ color: "var(--text-muted)" }}
        >
          {Icon ? <Icon className="h-3 w-3 shrink-0" strokeWidth={2} /> : null}
          <span className="truncate">{title}</span>
        </span>
        {right}
      </div>
      <div className="p-2.5 @min-[28rem]/panel:p-3">{children}</div>
    </motion.section>
  );
}
