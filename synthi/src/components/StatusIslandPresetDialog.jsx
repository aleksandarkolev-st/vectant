'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { sanitizeStatusIslandPresetLabel } from '@/lib/statusIslandPreferences';

export default function StatusIslandPresetDialog({
  open = false,
  initialValue = '',
  title = 'Save status island preset',
  description = 'Store the current compact, lock, and dock layout as a reusable preset.',
  confirmLabel = 'Save preset',
  onOpenChange,
  onSubmit,
}) {
  const [value, setValue] = useState(initialValue);
  const [error, setError] = useState('');

  useEffect(() => {
    if (!open) return;
    setValue(initialValue || '');
    setError('');
  }, [initialValue, open]);

  const normalizedValue = sanitizeStatusIslandPresetLabel(value);

  const handleSubmit = () => {
    if (!normalizedValue) {
      setError('Preset name cannot be empty.');
      return;
    }

    const shouldClose = onSubmit?.(value) !== false;
    if (shouldClose) {
      setError('');
      onOpenChange?.(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) {
          setError('');
        }
        onOpenChange?.(nextOpen);
      }}
    >
      <DialogContent
        className="max-w-md"
        style={{
          background: 'var(--bg-elevated)',
          borderColor: 'var(--border-medium)',
          color: 'var(--text-primary)',
        }}
      >
        <DialogHeader>
          <DialogTitle className="text-base" style={{ color: 'var(--text-primary)' }}>
            {title}
          </DialogTitle>
          <DialogDescription style={{ color: 'var(--text-muted)' }}>
            {description}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 pt-2">
          <Input
            value={value}
            autoFocus
            maxLength={40}
            placeholder="Preset name"
            onChange={(event) => {
              setValue(event.target.value);
              if (error) {
                setError('');
              }
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                handleSubmit();
              }
            }}
          />

          <div className="flex items-center justify-between text-[11px]">
            <span style={{ color: error ? 'var(--accent-danger)' : 'var(--text-muted)' }}>
              {error || 'Up to 40 characters.'}
            </span>
            <span style={{ color: 'var(--text-disabled)' }}>
              {normalizedValue.length}/40
            </span>
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange?.(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={!normalizedValue}>
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}