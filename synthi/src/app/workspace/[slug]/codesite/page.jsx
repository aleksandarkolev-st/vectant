import CodeSitePanel from '@/components/codesite/CodeSitePanel';

export const dynamic = 'force-dynamic';

export default async function CodeSiteWorkspacePage({ params }) {
  const { slug } = await params;

  return (
    <main
      className="h-screen w-screen overflow-hidden"
      style={{ background: 'var(--bg-sidebar)', color: 'var(--text-primary)' }}
    >
      <CodeSitePanel workspaceSlug={slug} />
    </main>
  );
}
