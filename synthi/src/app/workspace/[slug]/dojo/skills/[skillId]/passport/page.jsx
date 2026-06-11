import SkillPassport from '@/components/dojo/SkillPassport';

export default async function DojoSkillPassportPage({ params }) {
  const resolvedParams = await params;
  return (
    <SkillPassport
      workspaceSlug={resolvedParams?.slug || ''}
      skillId={resolvedParams?.skillId || ''}
    />
  );
}
