'use client';

import React from 'react';
import { useShadowVerify } from './hooks/useShadowVerify';

/**
 * Synthi Genome — MultiverseCard
 *
 * Renders the verify panel for a shadow job. In Wave 1 there is exactly
 * one universe per job, but the component is structured to render N
 * universes once Wave 2 lifts the count.
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

function UniverseRow({ universe, onApply }) {
    const { id, stage, modelGen, modelCritic, style, evidence } = universe;
    const verified = stage === 'done' && evidence?.diagnostics &&
        evidence.diagnostics.lint !== 'failed' &&
        (evidence.attacks?.failed || []).length === 0;

    return (
        <div className="genome-universe">
            <div className="genome-universe__head">
                <span className="genome-universe__id">Universe {id}</span>
                <span className="genome-universe__model">
                    {modelGen}
                    {modelCritic && modelGen !== modelCritic ? ` → ${modelCritic} critic` : ''}
                </span>
                <span className="genome-universe__style">{style}</span>
                <span className={`genome-universe__status genome-universe__status--${verified ? 'ok' : stage}`}>
                    {stage === 'done' ? (verified ? '✓ verified' : '⚠ issues') : (STAGE_LABEL[stage] || stage)}
                </span>
            </div>
            {evidence ? (
                <div className="genome-universe__evidence">
                    <span>lint: {diagText(evidence.diagnostics?.lint)}</span>
                    <span>· types: {diagText(evidence.diagnostics?.types)}</span>
                    <span>· tests: {evidence.diagnostics?.tests || 'skipped'}</span>
                    <span>· runtime: {evidence.diagnostics?.runtime || 'skipped'}</span>
                    <span>· attacks {evidence.attacks?.survived || 0}/{evidence.attacks?.tested || 0} survived</span>
                    <span>· LOC {evidence.loc}</span>
                    <span>· score {evidence.score}</span>
                </div>
            ) : null}
            {evidence?.attacks?.failed?.length ? (
                <ul className="genome-universe__attacks">
                    {evidence.attacks.failed.map((a, i) => (
                        <li key={i}>
                            <strong>{a.severity}</strong> · {a.kind || 'logic'} · {a.msg}
                        </li>
                    ))}
                </ul>
            ) : null}
            {stage === 'done' ? (
                <div className="genome-universe__actions">
                    <button type="button" onClick={() => onApply(id)} disabled={!verified}>Apply</button>
                </div>
            ) : null}
        </div>
    );
}

export function MultiverseCard({ jobId }) {
    const verify = useShadowVerify(jobId);
    if (!jobId) return null;
    const universes = Object.values(verify.universes || {});

    return (
        <div className="genome-card">
            <header className="genome-card__head">
                <span>🛡 Verify panel</span>
                {verify.tier ? <span className="genome-card__tier">tier: {verify.tier}</span> : null}
                {!verify.finished && (
                    <button type="button" className="genome-card__cancel" onClick={() => verify.cancel()}>
                        cancel
                    </button>
                )}
            </header>
            {verify.error ? (
                <div className="genome-card__error">error: {verify.error}</div>
            ) : null}
            {universes.length === 0 ? (
                <div className="genome-card__empty">starting universe…</div>
            ) : (
                universes.map((u) => (
                    <UniverseRow key={u.id} universe={u} onApply={(id) => verify.apply(id)} />
                ))
            )}
            {verify.finished && verify.winner ? (
                <footer className="genome-card__foot">winner: Universe {verify.winner}</footer>
            ) : null}
        </div>
    );
}

export default MultiverseCard;
