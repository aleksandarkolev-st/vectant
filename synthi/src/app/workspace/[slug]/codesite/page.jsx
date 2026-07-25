import CodeSitePanel from '@/components/codesite/CodeSitePanel';

export const dynamic = 'force-dynamic';

export default async function CodeSiteWorkspacePage({ params }) {
  const { slug } = await params;

  return (
    <main
      data-panel-type="codesite"
      className="vt-panel-frame h-[100dvh] min-h-[100dvh] w-screen overflow-hidden"
    >
      <CodeSitePanel workspaceSlug={slug} />
    </main>
  );
}
