/**
 * useVirtualizedTree – flattens a recursive file-tree into a flat array of
 * visible rows suitable for react-virtuoso.  Each row carries all the props
 * that FileItem needs so it can render in "shallow" (non-recursive) mode.
 */
import { useMemo } from 'react';
import { useAppSelector } from '@/redux/hooks';
import { selectExpandedFolders } from '@/redux/uiSlice';

/**
 * @typedef {Object} FlatNode
 * @property {Object}   item               – original tree node
 * @property {number}   level              – depth (0 = root)
 * @property {boolean[]} ancestorHasNext   – per-level "has next sibling" flags for tree guides
 * @property {boolean}  hasNextSibling     – whether there is a sibling after this node
 * @property {number}   parentChildCount   – total children of parent
 * @property {string}   key                – stable React key
 */

function sortNodes(nodes) {
  return [...nodes].sort((a, b) => {
    if (a.isFolder && !b.isFolder) return -1;
    if (!a.isFolder && b.isFolder) return 1;
    return a.name.localeCompare(b.name);
  });
}

/**
 * Walk the tree recursively, yielding only nodes whose ancestor folders are
 * all expanded.  The walk is DFS pre-order (parent before children) so the
 * flat list matches the visual order.
 */
function flatten(nodes, expandedSet, level, ancestorHasNext, uiActionState) {
  const sorted = sortNodes(nodes);
  const result = [];

  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i];
    const hasNextSibling = i < sorted.length - 1;

    result.push({
      item,
      level,
      ancestorHasNext: [...ancestorHasNext],
      hasNextSibling,
      parentChildCount: sorted.length,
      key: item.path || `node-${level}-${i}`,
    });

    // Recurse into expanded folders
    const isExpanded = expandedSet.has(item.path);
    const isCreationTarget =
      uiActionState.mode.startsWith('create') &&
      uiActionState.target &&
      item.path === uiActionState.target.path;

    if (item.isFolder && (isExpanded || isCreationTarget) && item.children?.length) {
      const childRows = flatten(
        item.children,
        expandedSet,
        level + 1,
        [...ancestorHasNext, hasNextSibling],
        uiActionState,
      );
      result.push(...childRows);
    }
  }

  return result;
}

/**
 * Hook: returns flattened visible rows for virtualised rendering.
 * Re-computes only when the tree, expanded-folders set, or UI action changes.
 */
export function useVirtualizedTree(files, uiActionState) {
  const expandedFolders = useAppSelector(selectExpandedFolders);
  const expandedSet = useMemo(() => new Set(expandedFolders), [expandedFolders]);

  const flatNodes = useMemo(
    () => flatten(files, expandedSet, 0, [], uiActionState),
    [files, expandedSet, uiActionState],
  );

  return flatNodes;
}
