import SkillCortexGraph from '@/components/dojo/SkillCortexGraph';

export default async function DojoSkillCortexPage({ params }) {
  const resolvedParams = await params;
  return (
    <SkillCortexGraph
      workspaceSlug={resolvedParams?.slug || ''}
      skillId={resolvedParams?.skillId || ''}
    />
  );
}
