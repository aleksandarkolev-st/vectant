"use client";

import { useEffect } from "react";
import { toast } from "sonner";

export default function GlobalErrorHandler() {
  useEffect(() => {
    const handleError = (error) => {
      try {
        // Ignore Canceled errors from Monaco or other promises
        if (error === 'Canceled' || error?.message === 'Canceled' || error?.name === 'Canceled' || error?.code === 'Canceled' || (typeof error === 'string' && error.includes('Canceled'))) {
            return;
        }

        // Ignore benign ResizeObserver errors
        const msg = error?.message || (typeof error === 'string' ? error : '');
        if (msg.includes('ResizeObserver loop limit exceeded') || msg.includes('ResizeObserver loop completed with undelivered notifications')) {
            return;
        }

        if (error && (error.name === "SynthiException" || (error.title && error.description))) {
          toast.error(error.title, {
            description: error.description,
            duration: 5000,
          });
          // eslint-disable-next-line no-console
          console.error("SynthiException captured:", error);
          return;
        }

        const message = error?.message || (typeof error === "string" ? error : "An unexpected error occurred");
        toast.error(message);

        // eslint-disable-next-line no-console
        console.error("Global error captured:", error);
      } catch (e) {
        // eslint-disable-next-line no-console
        console.error("Error in GlobalErrorHandler:", e);
      }
    };

    const onWindowError = (event) => {
      handleError(event.error || event.message);
    };

    const onRejection = (event) => {
      handleError(event.reason);
    };

    window.addEventListener("error", onWindowError);
    window.addEventListener("unhandledrejection", onRejection);

    return () => {
      window.removeEventListener("error", onWindowError);
      window.removeEventListener("unhandledrejection", onRejection);
    };
  }, []);

  return null;
}