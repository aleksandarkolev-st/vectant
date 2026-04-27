'use client';

import { useEffect, useState } from 'react';

/**
 * Breakpoints (px). Aligned with Tailwind's defaults so utility classes
 * line up with the JS-driven behaviour:
 *   mobile  : < 640
 *   tablet  : < 1024 (and >= 640)
 *   narrow  : < 1280 (catches small laptop windows where the editor
 *             cannot reasonably host sidebar + chat + editor at once)
 *   desktop : >= 1280
 */
export const BREAKPOINTS = {
    mobile: 640,
    tablet: 1024,
    narrow: 1280,
};

const SSR_DEFAULT = {
    width: 1440,
    height: 900,
    isMobile: false,
    isTablet: false,
    isNarrow: false,
    isDesktop: true,
    isTouch: false,
};

function readViewport() {
    if (typeof window === 'undefined') return SSR_DEFAULT;
    const width = window.innerWidth;
    const height = window.innerHeight;
    const isMobile = width < BREAKPOINTS.mobile;
    const isTablet = !isMobile && width < BREAKPOINTS.tablet;
    const isNarrow = width < BREAKPOINTS.narrow;
    const isDesktop = !isNarrow;
    const isTouch =
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(pointer: coarse)').matches;
    return { width, height, isMobile, isTablet, isNarrow, isDesktop, isTouch };
}

/**
 * useViewport — observes window resize + orientation changes and reports
 * the current breakpoint. SSR-safe: returns desktop defaults until the
 * first client effect.
 */
export function useViewport() {
    const [vp, setVp] = useState(SSR_DEFAULT);

    useEffect(() => {
        let raf = 0;
        const update = () => {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(() => setVp(readViewport()));
        };
        update();
        window.addEventListener('resize', update);
        window.addEventListener('orientationchange', update);
        return () => {
            cancelAnimationFrame(raf);
            window.removeEventListener('resize', update);
            window.removeEventListener('orientationchange', update);
        };
    }, []);

    return vp;
}

export default useViewport;
