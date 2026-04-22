'use client';

// `/workspace/<slug>/operator` — operator observability view for the
// session identified by `slug`. Thin wrapper; all state lives in
// `OperatorPanel`.

import { use } from 'react';
import OperatorPanel from './OperatorPanel.jsx';

export default function OperatorPage({ params }) {
  const { slug } = use(params);
  return <OperatorPanel sessionId={slug} />;
}
