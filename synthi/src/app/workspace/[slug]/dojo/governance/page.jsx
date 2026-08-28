import GovernanceDashboard from '@/components/dojo/GovernanceDashboard';

export default async function DojoGovernancePage({ params }) {
  const resolvedParams = await params;
  return <GovernanceDashboard workspaceSlug={resolvedParams?.slug || ''} />;
}
