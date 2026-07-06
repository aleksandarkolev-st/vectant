'use client';

import { useCallback, useRef, useState } from 'react';
import ConfirmDialog from '@/components/programs/ConfirmDialog';

export function useConfirmDialog() {
  const resolverRef = useRef(null);
  const [options, setOptions] = useState(null);

  const close = useCallback((value) => {
    const resolver = resolverRef.current;
    resolverRef.current = null;
    setOptions(null);
    resolver?.(value);
  }, []);

  const confirm = useCallback((nextOptions) => new Promise((resolve) => {
    resolverRef.current?.(false);
    resolverRef.current = resolve;
    setOptions(nextOptions || {});
  }), []);

  const confirmDialog = options ? (
    <ConfirmDialog
      {...options}
      onConfirm={() => close(true)}
      onCancel={() => close(false)}
    />
  ) : null;

  return { confirm, confirmDialog };
}
