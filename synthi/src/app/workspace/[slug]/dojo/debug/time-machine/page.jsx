import TimeMachineDebugger from '@/components/dojo/TimeMachineDebugger';

export default async function DojoTimeMachinePage({ params }) {
  const resolvedParams = await params;
  return <TimeMachineDebugger workspaceSlug={resolvedParams?.slug || ''} />;
}
