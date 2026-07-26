import { CodeSiteIcons } from "../icons";
import { Pill, Section } from "../ui";
import FilesystemBoundaryProofPanel from "./quarantine/FilesystemBoundaryProofPanel";
import QuarantineReviewPanel from "./quarantine/QuarantineReviewPanel";

export default function QuarantineView({
  filesystemBoundaryProofs,
  actionableQuarantineRecords,
  quarantineError,
  selectedQuarantineId,
  quarantineReview,
  onSelectQuarantine,
  onToggleQuarantinePath,
  onReplayQuarantine,
  onApplyQuarantine,
  disabled,
}) {
  return (
    <>
      <Section
        title="Filesystem Boundary Evidence"
        icon={CodeSiteIcons.files}
        right={
          <Pill
            tone={
              filesystemBoundaryProofs.some(
                (record) => !record.proofComplete,
              )
                ? "holding"
                : filesystemBoundaryProofs.length
                  ? "active"
                  : "idle"
            }
          >
            {filesystemBoundaryProofs.length}
          </Pill>
        }
      >
        <FilesystemBoundaryProofPanel
          records={filesystemBoundaryProofs}
        />
      </Section>

      <Section
        title="Quarantine Review"
        icon={CodeSiteIcons.quarantine}
        // Keep the section when a fetch failed, or the error would vanish
        // along with it.
        count={actionableQuarantineRecords.length || (quarantineError ? 1 : 0)}
        hideWhenEmpty
        right={
          <Pill
            tone={
              actionableQuarantineRecords.length ? "holding" : "active"
            }
          >
            {actionableQuarantineRecords.length}
          </Pill>
        }
      >
        <QuarantineReviewPanel
          records={actionableQuarantineRecords}
          fetchError={quarantineError}
          selectedId={selectedQuarantineId}
          selectedPaths={quarantineReview.selectedPaths}
          reviewState={quarantineReview}
          onSelect={onSelectQuarantine}
          onTogglePath={onToggleQuarantinePath}
          onReplay={onReplayQuarantine}
          onApply={onApplyQuarantine}
          disabled={disabled}
        />
      </Section>
    </>
  );
}
