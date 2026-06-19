import CaseLawDashboard from '@/components/dojo/CaseLawDashboard';

export default async function DojoCaseLawPage({ params }) {
  const resolvedParams = await params;
  return <CaseLawDashboard workspaceSlug={resolvedParams?.slug || ''} />;
}
