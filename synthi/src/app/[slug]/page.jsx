import { redirect } from 'next/navigation';

const RESERVED_ROOT_PATHS = new Set([
  'agent-workflow-visual',
  'api',
  'collab',
  'extension-test',
  'login',
  'workspace',
]);

export default async function WorkspaceSlugEntry({ params, searchParams }) {
  const { slug } = await params;
  const query = await searchParams;
  const safeSlug = encodeURIComponent(slug || '');

  if (!slug || RESERVED_ROOT_PATHS.has(slug)) {
    redirect('/');
  }

  const collabSessionId = query?.collab || query?.sessionId;
  const inviteToken = query?.token;
  if (collabSessionId && inviteToken) {
    const next = new URLSearchParams();
    next.set('token', inviteToken);
    if (query?.code) next.set('code', query.code);
    redirect(`/collab/${encodeURIComponent(collabSessionId)}?${next.toString()}`);
  }

  redirect(`/workspace/${safeSlug}`);
}
