import DojoShell from '@/components/dojo/DojoShell';

export default async function DojoPage({ params }) {
  const resolvedParams = await params;
  return <DojoShell workspaceSlug={resolvedParams?.slug || ''} />;
}
