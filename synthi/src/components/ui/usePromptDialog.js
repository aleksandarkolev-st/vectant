'use client';

import { useCallback, useRef, useState } from 'react';
import PromptDialog from './PromptDialog';

export function usePromptDialog() {
  const resolverRef = useRef(null);
  const [options, setOptions] = useState(null);

  const close = useCallback((value) => {
    const resolver = resolverRef.current;
    resolverRef.current = null;
    setOptions(null);
    resolver?.(value);
  }, []);

  const prompt = useCallback((nextOptions) => new Promise((resolve) => {
    resolverRef.current?.(null);
    resolverRef.current = resolve;
    setOptions(nextOptions || {});
  }), []);

  const promptDialog = options ? (
    <PromptDialog
      {...options}
      onSubmit={(value) => close(value)}
      onCancel={() => close(null)}
    />
  ) : null;

  return { prompt, promptDialog };
}
