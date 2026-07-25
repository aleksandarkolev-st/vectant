import { CodeSiteIcons } from "../icons";
import { Pill, Section } from "../ui";
import CausalReplayDeck from "./replay/CausalReplayDeck";
import LineProvenanceDeck from "./replay/LineProvenanceDeck";
import { replayCompletenessTone } from "./replay/handovers";

export default function ReplayView({
  replayHandovers,
  lineProvenance,
  selectedLineRow,
  selectedLineTransaction,
  selectedLineLease,
  selectedLineProof,
  selectedLineEvidenceRefs,
  selectedLineInspectionRefs,
  selectedLineDojoRefs,
  lineInspector,
  onInspectLine,
}) {
  return (
    <>
      <Section
        title="Replay Handover"
        icon={CodeSiteIcons.replay}
        right={
          <Pill
            tone={
              replayHandovers.length
                ? replayCompletenessTone(
                    replayHandovers[0].completeness,
                  )
                : "pending"
            }
          >
            {replayHandovers.length}
          </Pill>
        }
      >
        <CausalReplayDeck handovers={replayHandovers} />
      </Section>

      <Section
        title="Lineage Inspector"
        icon={CodeSiteIcons.lineage}
        right={<Pill>{lineProvenance.length}</Pill>}
      >
        <LineProvenanceDeck
          rows={lineProvenance}
          selectedLineRow={selectedLineRow}
          selectedLineTransaction={selectedLineTransaction}
          selectedLineLease={selectedLineLease}
          selectedLineProof={selectedLineProof}
          selectedLineEvidenceRefs={selectedLineEvidenceRefs}
          selectedLineInspectionRefs={selectedLineInspectionRefs}
          selectedLineDojoRefs={selectedLineDojoRefs}
          lineInspector={lineInspector}
          onInspectLine={onInspectLine}
        />
      </Section>
    </>
  );
}
