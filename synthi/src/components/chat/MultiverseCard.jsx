'use client';

import React from 'react';
import { useShadowVerify } from './hooks/useShadowVerify';
import { ArbiterCard } from './ArbiterCard';
import { CounterfactualControls } from './CounterfactualControls';
import { Eye, Image, ShieldCheck } from 'lucide-react';

/**
 * Synthi Genome - MultiverseCard
 *
 * Renders the verify panel for a shadow job. The component is structured for
 * N universes and surfaces counterfactual proof, selection, and policy state.
 */

const STAGE_LABEL = {
    starting: 'starting',
    applying: 'applying patch',
    installing: 'installing deps',
    linting: 'linting',
    'type-checking': 'type checking',
    types: 'type checking',
    testing: 'running tests',
    running: 'runtime probe',
    critiquing: 'adversarial critic',
    revising: 'revising',
    done: 'done',
};

function diagText(diag) {
    if (!diag || diag === 'skipped') return 'skipped';
    if (diag === 'clean') return 'clean';
    if (Array.isArray(diag)) return `${diag.length} error${diag.length === 1 ? '' : 's'}`;
    return String(diag);
}

function visualProofFromEvidence(evidence) {
    if (!evidence) return null;
    return evidence.visual_proof || evidence.visualProof || evidence.visual_snapshot || evidence.visualSnapshot || null;
}

function proofStatus(proof) {
    if (!proof) return 'missing';
    if (proof.status) return String(proof.status);
    const failed = proof.failed_visual_gates || proof.failedGates || proof.failed_gates || [];
    if (failed.length) return 'failed';
    if (proof.screenshot_sha256 || proof.screenshotSha256 || proof.raw_artifact_ref || proof.artifact_ref) return 'passed';
    return 'partial';
}

function shortHash(proof) {
    const value = proof?.screenshot_sha256 || proof?.screenshotSha256 || '';
    return value ? value.slice(0, 12) : 'not captured';
}

function UniverseRow({ universe, onApply, onReview, onExplanationReview, reviewed, explanationReviewed }) {
    const { id, stage, modelGen, modelCritic, style, evidence } = universe;
    const visualProof = visualProofFromEvidence(evidence);
    const visualStatus = proofStatus(visualProof);
    const visualRequired = Boolean(visualProof?.required || evidence?.visual_proof_required || evidence?.visualProofRequired);
    const verified = stage === 'done' && evidence?.diagnostics &&
        evidence.diagnostics.lint !== 'failed' &&
        (evidence.attacks?.failed || []).length === 0 &&
        (!visualRequired || visualStatus === 'passed');

    return (
        <div className="genome-universe">
            <div className="genome-universe__head">
                <span className="genome-universe__id">Universe {id}</span>
                <span className="genome-universe__model">
                    {modelGen}
                    {modelCritic && modelGen !== modelCritic ? ` to ${modelCritic} critic` : ''}
                </span>
                <span className="genome-universe__style">{style}</span>
                <span className={`genome-universe__status genome-universe__status--${verified ? 'ok' : stage}`}>
                    {stage === 'done' ? (verified ? 'verified' : 'issues') : (STAGE_LABEL[stage] || stage)}
                </span>
            </div>
            {evidence ? (
                <div className="genome-universe__evidence">
                    <span>lint: {diagText(evidence.diagnostics?.lint)}</span>
                    <span>types: {diagText(evidence.diagnostics?.types)}</span>
                    <span>tests: {evidence.diagnostics?.tests || 'skipped'}</span>
                    <span>runtime: {evidence.diagnostics?.runtime || 'skipped'}</span>
                    <span>attacks {evidence.attacks?.survived || 0}/{evidence.attacks?.tested || 0} survived</span>
                    <span>LOC {evidence.loc}</span>
                    <span>score {evidence.score}</span>
                </div>
            ) : null}
            {evidence?.attacks?.failed?.length ? (
                <ul className="genome-universe__attacks">
                    {evidence.attacks.failed.map((a, i) => (
                        <li key={i}>
                            <strong>{a.severity}</strong> {a.kind || 'logic'} {a.msg}
                        </li>
                    ))}
                </ul>
            ) : null}
            {visualProof ? (
                <div
                    className={`genome-universe__visual genome-universe__visual--${visualStatus}`}
                    data-testid={`visual-proof-${id}`}
                >
                    <span className="genome-universe__visual-title">
                        <Image className="w-3.5 h-3.5" aria-hidden="true" />
                        Visual proof {visualStatus}
                    </span>
                    <span>hash {shortHash(visualProof)}</span>
                    {visualProof.viewport ? <span>viewport {visualProof.viewport}</span> : null}
                    {visualProof.raw_artifact_ref || visualProof.artifact_ref ? (
                        <span>artifact {visualProof.raw_artifact_ref || visualProof.artifact_ref}</span>
                    ) : null}
                </div>
            ) : null}
            {stage === 'done' ? (
                <div className="genome-universe__actions">
                    <button
                        type="button"
                        className={reviewed ? 'genome-universe__review genome-universe__review--done th-focus-ring' : 'genome-universe__review th-focus-ring'}
                        onClick={() => onReview(id)}
                    >
                        <Eye className="w-3.5 h-3.5" aria-hidden="true" />
                        {reviewed ? 'Reviewed' : 'Mark reviewed'}
                    </button>
                    <button
                        type="button"
                        className={explanationReviewed ? 'genome-universe__review genome-universe__review--done th-focus-ring' : 'genome-universe__review th-focus-ring'}
                        onClick={() => onExplanationReview(id)}
                    >
                        {explanationReviewed ? 'Rationale reviewed' : 'Review rationale'}
                    </button>
                    <button type="button" className="th-focus-ring" onClick={() => onApply(id)} disabled={!verified}>Apply</button>
                </div>
            ) : null}
        </div>
    );
}

export function MultiverseCard({ jobId, workspacePath = null, taskClass = '' }) {
    const verify = useShadowVerify(jobId);
    if (!jobId) return null;
    const universes = Object.values(verify.universes || {});
    const learnedLines = verify.learnedLines || [];
    const policyHints = verify.policyHints || [];

    return (
        <div className="genome-card">
            <header className="genome-card__head">
                <span className="inline-flex items-center gap-1.5"><ShieldCheck className="w-3.5 h-3.5 text-[var(--attention-purple)]" strokeWidth={2} /> Verify panel</span>
                {verify.tier ? <span className="genome-card__tier">tier: {verify.tier}</span> : null}
                {!verify.finished && (
                    <button type="button" className="genome-card__cancel th-focus-ring" onClick={() => verify.cancel()}>
                        cancel
                    </button>
                )}
            </header>
            {verify.error ? (
                <div className="genome-card__error">error: {verify.error}</div>
            ) : null}
            {learnedLines.length > 0 ? (
                <div className="genome-card__learned" data-testid="counterfactual-learned-line">
                    <strong>Learned from this run:</strong> {learnedLines[0]}
                </div>
            ) : null}
            {verify.selectedUniverseId && verify.arbiter?.winner && verify.selectedUniverseId !== verify.arbiter.winner ? (
                <div className="genome-card__ambiguity" data-testid="counterfactual-selection-override">
                    Selection override recorded: Universe {verify.selectedUniverseId} was applied instead of the Arbiter recommendation, Universe {verify.arbiter.winner}.
                </div>
            ) : null}
            {verify.cancelled && learnedLines.length === 0 ? (
                <div className="genome-card__ambiguity" data-testid="counterfactual-ambiguity-note">
                    Cancellation recorded as ambiguous; no branch rejection lesson was created.
                </div>
            ) : null}
            {policyHints.length > 0 ? (
                <div className="genome-card__policy" data-testid="counterfactual-policy-hint">
                    Policy hint active: {policyHints[0]}
                </div>
            ) : null}
            {universes.length === 0 ? (
                <div className="genome-card__empty">waiting for branch telemetry...</div>
            ) : (
                universes.map((u) => (
                    <UniverseRow
                        key={u.id}
                        universe={u}
                        onApply={(id) => verify.apply(id)}
                        onReview={(id) => verify.markUniverseReviewed?.(id)}
                        reviewed={(verify.reviewedUniverseIds || []).includes(u.id)}
                        onExplanationReview={(id) => verify.markUniverseExplanationReviewed?.(id)}
                        explanationReviewed={(verify.openedExplanationUniverseIds || []).includes(u.id)}
                    />
                ))
            )}
            {verify.convergence || verify.arbiter ? (
                <ArbiterCard jobId={jobId} verify={verify} />
            ) : null}
            {verify.finished && verify.winner ? (
                <footer className="genome-card__foot">winner: Universe {verify.winner}</footer>
            ) : null}
            <CounterfactualControls workspacePath={workspacePath} taskClass={taskClass} />
        </div>
    );
}

export default MultiverseCard;
