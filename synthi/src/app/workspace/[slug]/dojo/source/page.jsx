import SourceApiDashboard from '@/components/dojo/SourceApiDashboard';

export default async function DojoSourceApiPage({ params }) {
  const resolvedParams = await params;
  return <SourceApiDashboard workspaceSlug={resolvedParams?.slug || ''} />;
}
