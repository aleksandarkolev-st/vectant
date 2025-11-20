"use client"

import { useEffect } from "react";
import { toast } from "sonner";

export default function GlobalErrorHandler() {
  useEffect(() => {
    // quick mount debug to confirm the handler is active
    // eslint-disable-next-line no-console
    console.debug("GlobalErrorHandler mounted");
    const onError = (event) => {
      try {
        // eslint-disable-next-line no-console
        console.debug("Global error captured event:", event);
        const message = event?.message || (event?.error && event.error.message) || String(event);
        // show toast with short message
        toast.error(message || "An unexpected error occurred");
        // also log full event
        // eslint-disable-next-line no-console
        console.error("Global error captured:", event);
      } catch (e) {
        // ignore
      }
    };

    const onRejection = (event) => {
      try {
        const reason = event?.reason || event;
        const message = reason && reason.message ? reason.message : String(reason);
        toast.error(message || "Unhandled promise rejection");
        // eslint-disable-next-line no-console
        console.error("Unhandled rejection:", event);
      } catch (e) {
        // ignore
      }
    };

    window.addEventListener("error", onError);
    window.addEventListener("unhandledrejection", onRejection);

    return () => {
      window.removeEventListener("error", onError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}
