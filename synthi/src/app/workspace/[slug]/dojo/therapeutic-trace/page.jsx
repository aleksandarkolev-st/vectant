import TherapeuticTomographyTrace from '@/components/dojo/TherapeuticTomographyTrace';

export default async function TherapeuticTracePage({ params }) {
  const resolvedParams = await params;
  return <TherapeuticTomographyTrace workspaceSlug={resolvedParams?.slug || ''} />;
}
