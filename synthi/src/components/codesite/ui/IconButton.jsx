import { MOTION_EASE } from "../lib/motion";
import { motion, useReducedMotion } from "framer-motion";

export default function IconButton({
  title,
  onClick,
  disabled,
  children,
  variant = "neutral",
  testId,
  type = "button",
}) {
  const active = variant === "primary";
  const reduceMotion = useReducedMotion();
  return (
    <motion.button
      type={type}
      data-testid={testId}
      title={title}
      aria-label={title}
      onClick={onClick}
      disabled={disabled}
      whileHover={disabled || reduceMotion ? undefined : { y: -1 }}
      whileTap={disabled || reduceMotion ? undefined : { scale: 0.985 }}
      transition={{ duration: reduceMotion ? 0 : 0.18, ease: MOTION_EASE }}
      className="inline-flex min-h-11 items-center justify-center gap-1.5 rounded-md border px-3 text-xs font-semibold outline-none transition-[background,border-color,box-shadow,opacity] duration-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--attention-purple)] disabled:cursor-not-allowed disabled:opacity-50"
      style={{
        borderColor: active
          ? "color-mix(in srgb, var(--accent-primary) 62%, var(--border-subtle))"
          : "color-mix(in srgb, var(--border-subtle) 86%, var(--text-primary) 8%)",
        background: active
          ? "color-mix(in srgb, var(--accent-primary) 18%, var(--bg-elevated))"
          : "var(--bg-elevated)",
        color: "var(--text-primary)",
        boxShadow: active
          ? "inset 0 1px 0 color-mix(in srgb, var(--accent-primary) 28%, transparent)"
          : "inset 0 1px 0 color-mix(in srgb, var(--text-primary) 7%, transparent)",
        transitionTimingFunction: "cubic-bezier(0.16, 1, 0.3, 1)",
      }}
    >
      {children}
    </motion.button>
  );
}
