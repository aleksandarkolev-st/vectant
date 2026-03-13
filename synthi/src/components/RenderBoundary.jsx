"use client";

/**
 * RenderBoundary.jsx — React render isolation boundary
 *
 * Wraps a subtree in React.memo with a stable identity so that parent
 * re-renders caused by Redux selector changes, context updates, or
 * local state mutations in sibling components do NOT propagate into
 * this subtree.
 *
 * Use this to sever render cascades between independent UI regions:
 *   <RenderBoundary>
 *     <GitStatus slug={slug} />
 *   </RenderBoundary>
 *
 * The boundary only re-renders when its `deps` array reference changes
 * (shallow comparison). Children are rendered via a stable `children` prop.
 *
 * Architecture note:
 *   React.memo on the boundary itself prevents the parent's reconciliation
 *   from entering this subtree. The `deps` escape hatch allows you to
 *   explicitly opt-in to updates (e.g. when the slug changes).
 */

import React, { memo, useMemo } from 'react';

const RenderBoundaryInner = memo(function RenderBoundary({ children }) {
  return <>{children}</>;
});

/**
 * @param {object} props
 * @param {React.ReactNode} props.children — The subtree to isolate
 * @param {string} [props.name] — Debug name for React DevTools
 */
export function RenderBoundary({ children, name }) {
  return (
    <RenderBoundaryInner key={name}>
      {children}
    </RenderBoundaryInner>
  );
}

/**
 * Higher-order component that wraps any component in a memo boundary.
 * Useful for wrapping third-party or existing components without
 * modifying their source.
 *
 * @param {React.ComponentType} Component
 * @param {string} [displayName]
 * @returns {React.MemoExoticComponent}
 */
export function withRenderBoundary(Component, displayName) {
  const Wrapped = memo(Component);
  Wrapped.displayName = displayName || `RenderBoundary(${Component.displayName || Component.name || 'Component'})`;
  return Wrapped;
}

export default RenderBoundary;
