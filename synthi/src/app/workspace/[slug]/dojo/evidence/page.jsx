import EvidenceDashboard from '@/components/dojo/EvidenceDashboard';

export default async function DojoEvidencePage({ params }) {
  const resolvedParams = await params;
  return <EvidenceDashboard workspaceSlug={resolvedParams?.slug || ''} />;
}
