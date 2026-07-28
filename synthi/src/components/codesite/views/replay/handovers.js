import { asArray, compact, uniqueValues } from "../../lib/format";

export function causalReplayHandovers(incidents, proofBundles) {
  return asArray(incidents)
    .filter((incident) => incident?.replayDigest || incident?.incidentReplay)
    .map((incident) => {
      const replay = incident.incidentReplay || {};
      const transactionId =
        replay.transaction?.id ||
        replay.transactionId ||
        asArray(replay.causalEvents)
          .map((event) => event.transactionId || event.details?.transactionId)
          .find(Boolean) ||
        null;
      const proofBundle =
        asArray(proofBundles).find(
          (bundle) =>
            bundle.incidentReplayDigest === incident.replayDigest ||
            bundle.id === replay.proofBundle?.id ||
            (transactionId && bundle.transactionId === transactionId),
        ) || null;
      const codeSiteBlackBox =
        proofBundle?.trailers?.["CodeSite-Black-Box"] ||
        proofBundle?.incidentReplayDigest ||
        incident.replayDigest ||
        replay.proofBundle?.incidentReplayDigest ||
        null;
      const exportPaths = uniqueValues([
        ...asArray(replay.handover?.exportPaths),
        `incidents/incident-replay-${incident.id}.jsonl`,
        "handover.md",
        proofBundle?.id && `proof-bundles/${proofBundle.id}.proof.json`,
        proofBundle?.id && `proof-bundles/${proofBundle.id}.trailers.txt`,
      ]);
      return {
        incident,
        replay,
        transactionId,
        proofBundle,
        codeSiteBlackBox,
        exportPaths,
        causalEvents: asArray(replay.causalEvents),
        completeness: replay.completeness || null,
      };
    })
    .sort(
      (left, right) =>
        Date.parse(right.incident.createdAt || 0) -
        Date.parse(left.incident.createdAt || 0),
    );
}

export function replayCompletenessTone(completeness) {
  const score = Number(completeness?.score);
  if (!Number.isFinite(score)) return "pending";
  if (score >= 0.75) return "active";
  if (score >= 0.45) return "warning";
  return "blocked";
}
