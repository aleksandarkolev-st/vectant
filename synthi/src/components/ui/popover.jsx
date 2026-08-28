'use client';

import * as React from 'react';
import * as PopoverPrimitive from '@radix-ui/react-popover';

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;

export const PopoverContent = React.forwardRef(function PopoverContent(
  { className = '', sideOffset = 2, align = 'start', children, ...props },
  ref
) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        ref={ref}
        sideOffset={sideOffset}
        align={align}
        className={`vt-command-popover z-50 p-0 focus:outline-none ${className}`}
        {...props}
      >
        {children}
      </PopoverPrimitive.Content>
    </PopoverPrimitive.Portal>
  );
});

