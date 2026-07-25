import { MOTION_EASE } from "../lib/motion";
import { motion, useReducedMotion } from "framer-motion";

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
      className={`min-w-0 overflow-hidden rounded-lg border p-1 ${className}`}
      style={{
        borderColor:
          "color-mix(in srgb, var(--border-subtle) 84%, var(--accent-primary) 16%)",
        background: "color-mix(in srgb, var(--bg-surface) 96%, var(--bg-editor) 4%)",
      }}
    >
      <div
        className="flex min-h-12 items-center justify-between gap-3 rounded-md border px-3 py-2"
        style={{
          borderColor:
            "color-mix(in srgb, var(--border-subtle) 90%, var(--text-primary) 6%)",
          background: "var(--bg-elevated)",
        }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <span
            className="grid h-7 w-7 shrink-0 place-items-center rounded-md"
            style={{
              background:
                "color-mix(in srgb, var(--accent-primary) 8%, transparent)",
            }}
          >
            <Icon
              className="h-3.5 w-3.5"
              style={{ color: "var(--accent-primary)" }}
            />
          </span>
          <h3
            className="truncate text-sm font-semibold"
            style={{ color: "var(--text-primary)" }}
          >
            {title}
          </h3>
        </div>
        {right}
      </div>
      <div className="p-2.5 sm:p-3">{children}</div>
    </motion.section>
  );
}
