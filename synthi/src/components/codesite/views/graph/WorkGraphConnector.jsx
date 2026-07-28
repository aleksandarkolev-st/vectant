import { MOTION_EASE, STATUS_PULSE_EASE } from "../../lib/motion";
import { motion, useReducedMotion } from "framer-motion";
import { statusColor } from "../../lib/graph";

export default function WorkGraphConnector({ tone = "active", active = false, delay = 0 }) {
  const reduceMotion = useReducedMotion();
  const color = statusColor(tone);
  return (
    <div
      className="hidden min-w-0 items-center justify-center md:flex"
      aria-hidden="true"
    >
      <div className="relative h-6 w-full min-w-[28px]">
        <motion.span
          className="absolute left-0 right-0 top-1/2 h-px origin-left rounded-full"
          style={{
            background: `linear-gradient(90deg, transparent, ${color}, transparent)`,
          }}
          initial={reduceMotion ? false : { scaleX: 0.15, opacity: 0.35 }}
          animate={{ scaleX: 1, opacity: active ? 0.92 : 0.55 }}
          transition={{
            duration: reduceMotion ? 0 : 0.28,
            delay: reduceMotion ? 0 : delay,
            ease: MOTION_EASE,
          }}
        />
        <motion.span
          className="absolute left-1/2 top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full"
          style={{
            background: color,
            boxShadow: `0 0 0 3px color-mix(in srgb, ${color} 18%, transparent)`,
          }}
          animate={
            !reduceMotion && active
              ? { opacity: [0.62, 1, 0.62], scale: [0.94, 1.16, 0.94] }
              : { opacity: 0.7, scale: 1 }
          }
          transition={{
            duration: 1.8,
            repeat: !reduceMotion && active ? Infinity : 0,
            ease: STATUS_PULSE_EASE,
          }}
        />
      </div>
    </div>
  );
}
