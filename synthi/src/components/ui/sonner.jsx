"use client"

import { useTheme } from "next-themes"
import { Toaster as Sonner } from "sonner";

const Toaster = ({
  ...props
}) => {
  const { theme = "system" } = useTheme()

  return (
    <Sonner
      theme={theme}
      richColors={true}
      position="bottom-right"
      closeButton={true}
      duration={6000}
      className="toaster group"
      style={{
        "--normal-bg": "rgba(255,255,255,0.95)",
        "--normal-text": "#0f172a",
        "--normal-border": "rgba(15,23,42,0.06)",
        // visual polish
        boxShadow: "0 10px 30px rgba(2,6,23,0.6)",
        borderRadius: "12px",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        zIndex: 99999,
      }}
      {...props}
    />
  );
}

export { Toaster }
