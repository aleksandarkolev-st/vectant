'use client';

// OperatorDialog — shadcn Dialog wrapper for the operator console.
// Reusable: accepts `open` + `onOpenChange` so it can be mounted from
// the /operator page (auto-open) or from any future IDE chrome button
// (trigger-driven). Body state lives in OperatorPanel so the underlying
// OperatorClient's WS is torn down cleanly when the dialog unmounts.

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/tabs';
import OperatorPanel from './OperatorPanel.jsx';
import EscapeHatchPanel from './EscapeHatchPanel.jsx';

export default function OperatorDialog({ sessionId, open, onOpenChange }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Operator console</DialogTitle>
          <DialogDescription>
            Presence + kill switch, plus the agent&rsquo;s escape-hatch queue.
          </DialogDescription>
        </DialogHeader>
        {open && sessionId ? (
          <Tabs defaultValue="presence" className="gap-4">
            <TabsList className="self-start">
              <TabsTrigger value="presence">Presence</TabsTrigger>
              <TabsTrigger value="escape-hatch">Escape hatch</TabsTrigger>
            </TabsList>
            <TabsContent value="presence">
              <OperatorPanel sessionId={sessionId} />
            </TabsContent>
            <TabsContent value="escape-hatch">
              <EscapeHatchPanel />
            </TabsContent>
          </Tabs>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
