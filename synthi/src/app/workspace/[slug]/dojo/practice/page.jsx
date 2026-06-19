import PracticeWorldDashboard from '@/components/dojo/PracticeWorldDashboard';

export default async function DojoPracticePage({ params }) {
  const resolvedParams = await params;
  return <PracticeWorldDashboard workspaceSlug={resolvedParams?.slug || ''} />;
}
