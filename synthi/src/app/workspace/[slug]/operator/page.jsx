'use client';

// `/workspace/<slug>/operator` — opens the operator console as a modal
// dialog on top of the workspace. When the user dismisses it (Esc or
// click outside), we navigate back to the parent workspace so the URL
// stays in sync with what's on screen.

import { use, useState } from 'react';
import { useRouter } from 'next/navigation';
import OperatorDialog from './OperatorDialog.jsx';

export default function OperatorPage({ params }) {
  const { slug } = use(params);
  const router = useRouter();
  const [open, setOpen] = useState(true);

  const handleOpenChange = (next) => {
    setOpen(next);
    if (!next) router.push(`/workspace/${slug}`);
  };

  return <OperatorDialog sessionId={slug} open={open} onOpenChange={handleOpenChange} />;
}
