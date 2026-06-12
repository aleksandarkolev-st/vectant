import SkillCardGrid from '@/components/dojo/SkillCardGrid';

export default async function DojoSkillCardsPage({ params }) {
  const resolvedParams = await params;
  return <SkillCardGrid workspaceSlug={resolvedParams?.slug || ''} />;
}
