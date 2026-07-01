import { asArray } from './json';

const METRIC_SCHEMA_VERSION = 'synthi.codesite.metrics.v1';

const METRIC_DEFINITIONS = {
  atc: [
    ['collisionsPredicted', 'Collisions predicted', 'count'],
    ['collisionsAvoided', 'Collisions avoided', 'count'],
    ['nearMissesReplayed', 'Near-misses replayed', 'count'],
    ['noFlyViolationsBlocked', 'No-fly violations blocked', 'count'],
    ['flightsReroutedByTower', 'Flights rerouted by tower', 'count'],
    ['flightsHeldBeforeSharedZoneConflict', 'Flights held before shared-zone conflict', 'count'],
    ['landingsPassedFirstTry', 'Landings passed first try', 'count'],
    ['goAroundRate', 'Go-around rate', 'ratio'],
    ['groundStopEvents', 'Ground-stop events', 'count'],
    ['averageTimeToClearanceMs', 'Average time to clearance', 'duration_ms'],
    ['averageTimeInHoldingMs', 'Average time in holding', 'duration_ms'],
  ],
  transaction: [
    ['staleReadsDetected', 'Stale reads detected', 'count'],
    ['assumptionInvalidationsBeforeWrite', 'Assumption invalidations before write', 'count'],
    ['serializableTransactionAbortRate', 'Serializable transaction abort rate', 'ratio'],
    ['shadowMergeSimulatorAccuracy', 'Shadow merge simulator accuracy', 'ratio'],
    ['codeSiteFsBlockedWrites', 'CodeSiteFS blocked writes', 'count'],
    ['illegalWritesQuarantined', 'Illegal writes quarantined', 'count'],
    ['proofBundlesVerifiedOutsideUi', 'Proof bundles verified outside UI', 'count'],
    ['lineProvenanceCoverage', 'Lines with causal provenance coverage', 'ratio'],
  ],
  quality: [
    ['mergeConflictsAvoided', 'Merge conflicts avoided', 'count'],
    ['contractDriftIncidents', 'Contract drift incidents', 'count'],
    ['migrationRollbackCoverage', 'Migration rollback coverage', 'ratio'],
    ['securityFindingsBeforeMerge', 'Security findings before merge', 'count'],
    ['testsRedAtLanding', 'Tests red at landing', 'count'],
    ['postMergeRollbackRate', 'Post-merge rollback rate', 'ratio'],
  ],
  trust: [
    ['percentageWritesWithValidClearance', 'Writes with valid clearance', 'ratio'],
    ['blackBoxCompletenessScore', 'Black-box completeness score', 'ratio'],
    ['humanReviewTimeSavedMs', 'Human review time saved', 'duration_ms'],
    ['pilotLicenseViolationRate', 'Pilot license violation rate', 'ratio'],
    ['repeatedNearMissesConvertedToAirspaceRules', 'Repeated near-misses converted to airspace rules', 'count'],
  ],
};

const NOT_INSTRUMENTED = new Set([
  'humanReviewTimeSavedMs',
]);

export function buildCodeSiteMetrics({ project, controlState = null, workspaceSlug = project?.workspaceSlug } = {}) {
  const generatedAt = new Date().toISOString();
  const normalized = normalizeMetricProject(project || {});
  const context = buildMetricContext(normalized, controlState, generatedAt);
  const computed = computeMetricValues(context);
  const sections = Object.fromEntries(Object.entries(METRIC_DEFINITIONS).map(([sectionKey, definitions]) => [
    sectionKey,
    definitions.map(([key, label, unit]) => metricRow(key, label, unit, computed[key], context)),
  ]));
  const summary = Object.fromEntries(Object.values(sections).flat().map((row) => [row.key, row.value]));

  return {
    schemaVersion: METRIC_SCHEMA_VERSION,
    projectId: normalized.id || null,
    workspaceSlug: workspaceSlug || normalized.workspaceSlug || null,
    generatedAt,
    status: 'measured',
    sections,
    summary,
    evidence: {
      eventTypeCounts: countBy(context.events, (event) => event.eventType),
      transactionStatusCounts: countBy(context.transactions, (txn) => txn.status),
      leaseStatusCounts: countBy(context.leases, (lease) => lease.status),
      inspectionStatusCounts: countBy(context.inspectionRuns, (run) => run.status),
      policyDecisionCounts: countBy(context.policyDecisions, (decision) => decision.decision),
      reasonCodeCounts: context.reasonCodeCounts,
      dataSources: {
        events: context.events.length,
        policyDecisions: context.policyDecisions.length,
        transactions: context.transactions.length,
        mutationLeases: context.leases.length,
        inspectionRuns: context.inspectionRuns.length,
        incidents: context.incidents.length,
        proofBundles: context.proofBundles.length,
        lineProvenance: context.lineProvenance.length,
        counterfactualRuns: context.counterfactualRuns.length,
        assumptions: context.assumptions.length,
      },
    },
  };
}

function normalizeMetricProject(project) {
  return {
    id: project.id,
    workspaceSlug: project.workspaceSlug,
    events: asArray(project.events),
    executionPlans: asArray(project.executionPlans),
    mutationLeases: asArray(project.mutationLeases),
    mutationTxns: asArray(project.mutationTxns || project.transactions),
    assumptions: asArray(project.assumptions),
    policyDecisions: asArray(project.policyDecisions),
    incidents: asArray(project.incidents),
    inspectionRuns: asArray(project.inspectionRuns),
    proofBundles: asArray(project.proofBundles),
    lineProvenance: asArray(project.lineProvenance),
    counterfactualRuns: asArray(project.counterfactualRuns),
    policyDeltas: asArray(project.policyDeltas),
    documents: asArray(project.documents),
    inboxItems: asArray(project.inboxItems),
  };
}

function buildMetricContext(project, controlState, generatedAt) {
  const events = project.events.map(normalizeEvent);
  const policyDecisions = project.policyDecisions.map(normalizePolicyDecision);
  const inspections = project.inspectionRuns.map(normalizeInspectionRun);
  const transactions = project.mutationTxns.map(normalizeTransaction);
  const leases = project.mutationLeases.map(normalizeLease);
  const incidents = project.incidents.map(normalizeIncident);
  const counterfactualRuns = project.counterfactualRuns.map(normalizeCounterfactualRun);
  const reasonCodes = [
    ...events.flatMap((event) => event.reasonCodes),
    ...policyDecisions.flatMap((decision) => decision.reasonCodes),
    ...transactions.flatMap((txn) => asArray(txn.commitDecision?.reasonCodes)),
    ...inspections.flatMap((run) => inspectionSignals(run).flatMap((signal) => asArray(signal.reasonCodes))),
    ...counterfactualRuns.flatMap((run) => counterfactualReasonCodes(run)),
  ];
  return {
    project,
    controlState,
    generatedAt,
    events,
    policyDecisions,
    inspectionRuns: inspections,
    transactions,
    leases,
    assumptions: project.assumptions,
    incidents,
    proofBundles: project.proofBundles,
    lineProvenance: project.lineProvenance,
    counterfactualRuns,
    policyDeltas: project.policyDeltas,
    reasonCodeCounts: countBy(reasonCodes, (code) => code),
  };
}

function computeMetricValues(context) {
  const forecastRisks = asArray(context.controlState?.collisionForecast?.risks);
  const nearMissIncidents = context.incidents.filter((incident) => incident.category === 'near_miss');
  const nearMissEvents = eventsOfType(context, 'near_miss');
  const shadowRiskUniverses = context.counterfactualRuns.flatMap((run) => counterfactualUniverses(run))
    .filter((universe) => Number(universe.predictedCollisionRisk) >= 0.5 || asArray(universe.unresolvedRisks).length > 0);
  const collisionAvoidanceSignals = [
    ...policyDecisionsWithReason(context, /collision_avoidance|shared_zone|tower_sequence|schema_first/),
    ...context.counterfactualRuns.flatMap((run) => selectedCounterfactualUniverses(run)
      .filter((universe) => asArray(universe.avoidedRisks).length > 0 || asArray(universe.reasonCodes).some((code) => /mitigated|avoided/.test(String(code))))
      .map((universe) => ({ id: run.id, universe }))),
  ];
  const noFlyBlocks = [
    ...eventsWithReason(context, /entered_no_fly_zone|no_fly/).filter((event) => event.eventType === 'write_denied'),
    ...policyDecisionsWithReason(context, /entered_no_fly_zone|no_fly/),
  ];
  const reroutes = [
    ...eventsOfType(context, 'tower_instruction').filter(isExplicitRerouteSignal),
    ...policyDecisionsWithReason(context, /reroute|route_deviation|alternate_route|route_reassigned/),
  ];
  const holds = [
    ...eventsOfType(context, 'holding_pattern'),
    ...policyDecisionsWithReason(context, /collision_avoidance_hold|shared_zone|holding/),
    ...context.leases.filter((lease) => lease.status === 'holding'),
  ];
  const landingGroups = groupBy(context.inspectionRuns, (run) => run.executionPlanId || run.displayCallsign || run.id);
  const firstLandings = [...landingGroups.values()].map((runs) => runs.sort(compareInspectionRuns)[0]).filter(Boolean);
  const failedLandings = context.inspectionRuns.filter((run) => inspectionFailed(run));
  const clearanceSamples = clearanceDurations(context);
  const holdingSamples = holdingDurations(context);
  const transactionValidationEvents = eventsOfType(context, 'transaction_validated');
  const staleReadCount = sum(transactionValidationEvents.map((event) => asArray(event.details?.decision?.staleReads).length
    || (asArray(event.details?.decision?.reasonCodes).includes('stale_read_detected') ? 1 : 0)));
  const invalidationCount = Math.max(
    context.assumptions.filter((assumption) => assumption.status === 'invalidated').length,
    sum(context.events.map((event) => asArray(event.details?.invalidatedAssumptions).length)),
  );
  const openedTransactions = context.transactions.length || eventsOfType(context, 'transaction_opened').length;
  const abortedTransactions = context.transactions.filter((txn) => txn.status === 'aborted').length || eventsOfType(context, 'transaction_aborted').length;
  const shadowAccuracySamples = context.counterfactualRuns
    .map((run) => {
      const selected = run.arbiterVerdict?.selected || run.arbiterVerdict?.strategy;
      const userChoice = run.userChoice?.selected || run.userChoice?.strategy || run.userChoice?.winner;
      if (!selected || !userChoice) return null;
      return selected === userChoice;
    })
    .filter((value) => value !== null);
  const codeSiteFsBlocked = eventsOfType(context, 'write_denied')
    .filter((event) => event.actorType === 'codesitefs' || event.details?.codesiteFsEvent || event.details?.source === 'codesitefs');
  const quarantined = eventsOfType(context, 'write_quarantined');
  const proofVerifierSignals = [
    ...eventsOfType(context, 'black_box_closed').filter((event) => event.details?.verifier || event.details?.proofBundleId || event.details?.proofBundleDigest),
    ...eventsOfType(context, 'proof_bundle_verified').filter((event) => event.details?.verifier || event.details?.status === 'verified'),
  ];
  const changedPaths = unique([
    ...context.transactions.flatMap((txn) => [...asArray(txn.writeSet), ...asArray(txn.observedWriteSet)]),
    ...context.events.flatMap((event) => normalizeEventPaths(event)),
  ]);
  const provenancePaths = unique(context.lineProvenance.map((row) => row.filePath).filter(Boolean));
  const mergeAvoided = context.counterfactualRuns.flatMap((run) => selectedCounterfactualUniverses(run))
    .filter((universe) => asArray(universe.avoidedRisks).some((risk) => /merge|conflict|collision/.test(String(risk))))
    .length;
  const contractDriftIncidents = context.incidents.filter((incident) => /contract|schema|drift/i.test([
    incident.category,
    ...asArray(incident.affectedZones),
    JSON.stringify(incident.policyDelta || {}),
  ].join(' ')));
  const migrationSignals = context.inspectionRuns.flatMap((run) => inspectionSignals(run))
    .filter((signal) => signalKey(signal) === 'migration');
  const securityFailedSignals = context.inspectionRuns.flatMap((run) => inspectionSignals(run))
    .filter((signal) => signalKey(signal) === 'security' && signalFailed(signal));
  const testFailedSignals = context.inspectionRuns.flatMap((run) => inspectionSignals(run))
    .filter((signal) => ['tests', 'test'].includes(signalKey(signal)) && signalFailed(signal));
  const rollbackIncidents = context.incidents.filter((incident) => /rollback|revert/i.test([incident.category, JSON.stringify(incident.incidentReplay || {})].join(' ')));
  const writeAllowed = eventsOfType(context, 'write_allowed');
  const writeAttemptGroups = uniqueWriteAttempts(context.events.filter((event) => ['write_attempted', 'write_allowed', 'write_denied', 'write_quarantined'].includes(event.eventType)));
  const validWriteAttemptGroups = writeAttemptGroups.filter((group) => group.some((event) => event.eventType === 'write_allowed' && event.mutationLeaseId));
  const blackBoxScores = context.incidents
    .map((incident) => Number(incident.incidentReplay?.completeness?.score))
    .filter(Number.isFinite);
  const pilotViolations = policyDecisionsWithReason(context, /dojo_proof_required|pilot_license|license/);
  const promotedNearMissRules = context.policyDeltas
    .filter((delta) => ['active', 'promoted', 'validated', 'accepted'].includes(String(delta.promotionState || '').toLowerCase()))
    .filter((delta) => asArray(delta.learnedFromIncidents).length > 0);

  return {
    collisionsPredicted: measured(forecastRisks.length + nearMissIncidents.length + shadowRiskUniverses.length, evidenceIds([...forecastRisks, ...nearMissIncidents, ...nearMissEvents])),
    collisionsAvoided: measured(collisionAvoidanceSignals.length, evidenceIds(collisionAvoidanceSignals)),
    nearMissesReplayed: measured(nearMissIncidents.filter((incident) => incident.incidentReplay || incident.replayDigest).length, evidenceIds(nearMissIncidents)),
    noFlyViolationsBlocked: measured(uniqueBy(noFlyBlocks, noFlyViolationKey).length, evidenceIds(noFlyBlocks)),
    flightsReroutedByTower: measured(uniqueIds(reroutes).length, evidenceIds(reroutes)),
    flightsHeldBeforeSharedZoneConflict: measured(uniqueIds(holds).length, evidenceIds(holds)),
    landingsPassedFirstTry: measured(firstLandings.filter((run) => !inspectionFailed(run)).length, evidenceIds(firstLandings)),
    goAroundRate: rateOrNotInstrumented(failedLandings.length, context.inspectionRuns.length, evidenceIds(failedLandings), 'Landing inspection runs are required to score go-around rate.'),
    groundStopEvents: measured(eventsOfType(context, 'ground_stop').length, evidenceIds(eventsOfType(context, 'ground_stop'))),
    averageTimeToClearanceMs: durationAverage(clearanceSamples),
    averageTimeInHoldingMs: durationAverage(holdingSamples),
    staleReadsDetected: measured(staleReadCount, evidenceIds(transactionValidationEvents.filter((event) => asArray(event.details?.decision?.reasonCodes).includes('stale_read_detected')))),
    assumptionInvalidationsBeforeWrite: measured(invalidationCount, evidenceIds(context.assumptions.filter((assumption) => assumption.status === 'invalidated'))),
    serializableTransactionAbortRate: rateOrNotInstrumented(abortedTransactions, openedTransactions, evidenceIds(context.transactions.filter((txn) => txn.status === 'aborted')), 'Serializable transaction openings are required to score abort rate.'),
    shadowMergeSimulatorAccuracy: shadowAccuracySamples.length
      ? ratio(shadowAccuracySamples.filter(Boolean).length, shadowAccuracySamples.length, evidenceIds(context.counterfactualRuns))
      : notInstrumented('Counterfactual user-choice outcomes are required to score simulator accuracy.'),
    codeSiteFsBlockedWrites: measured(codeSiteFsBlocked.length, evidenceIds(codeSiteFsBlocked)),
    illegalWritesQuarantined: measured(quarantined.length, evidenceIds(quarantined)),
    proofBundlesVerifiedOutsideUi: proofVerifierSignals.length
      ? measured(proofVerifierSignals.length, evidenceIds(proofVerifierSignals))
      : context.proofBundles.length
        ? notInstrumented('Proof bundles exist, but no external verifier or black-box closure event has been recorded.')
        : measured(0, []),
    lineProvenanceCoverage: changedPaths.length
      ? ratio(provenancePaths.filter((path) => changedPaths.some((changedPath) => pathsOverlap(path, changedPath))).length, changedPaths.length, evidenceIds(context.lineProvenance))
      : notInstrumented('Changed write paths are required to score line provenance coverage.'),
    mergeConflictsAvoided: measured(mergeAvoided, evidenceIds(context.counterfactualRuns)),
    contractDriftIncidents: measured(contractDriftIncidents.length, evidenceIds(contractDriftIncidents)),
    migrationRollbackCoverage: migrationSignals.length
      ? ratio(migrationSignals.filter((signal) => !signalFailed(signal)).length, migrationSignals.length, evidenceIds(migrationSignals))
      : notInstrumented('Migration rollback inspections have not run for this project.'),
    securityFindingsBeforeMerge: measured(securityFailedSignals.length, evidenceIds(securityFailedSignals)),
    testsRedAtLanding: measured(testFailedSignals.length, evidenceIds(testFailedSignals)),
    postMergeRollbackRate: rateOrNotInstrumented(rollbackIncidents.length, context.transactions.filter((txn) => txn.status === 'committed').length || eventsOfType(context, 'transaction_committed').length, evidenceIds(rollbackIncidents), 'Committed transactions are required to score rollback rate.'),
    percentageWritesWithValidClearance: writeAttemptGroups.length
      ? ratio(validWriteAttemptGroups.length, writeAttemptGroups.length, evidenceIds(validWriteAttemptGroups.flat()))
      : notInstrumented('Write-attempt lifecycle events are required to score clearance coverage.'),
    blackBoxCompletenessScore: blackBoxScores.length
      ? ratio(sum(blackBoxScores), blackBoxScores.length, evidenceIds(context.incidents))
      : notInstrumented('Incident replay completeness is available after black-box replay generation.'),
    humanReviewTimeSavedMs: notInstrumented('Human review baseline timing is not recorded yet.'),
    pilotLicenseViolationRate: rateOrNotInstrumented(pilotViolations.length, context.leases.length || eventsOfType(context, 'clearance_requested').length, evidenceIds(pilotViolations), 'Clearance requests or leases are required to score pilot-license violation rate.'),
    repeatedNearMissesConvertedToAirspaceRules: measured(promotedNearMissRules.length, evidenceIds(promotedNearMissRules)),
  };
}

function metricRow(key, label, unit, computed, context) {
  const fallback = NOT_INSTRUMENTED.has(key)
    ? notInstrumented('Metric requires an explicit baseline event before it can be measured.')
    : measured(0, []);
  const value = computed || fallback;
  return {
    key,
    label,
    unit,
    value: value.value,
    sampleSize: value.sampleSize,
    status: value.status,
    evidenceRefs: value.evidenceRefs,
    source: value.source || 'codesite_control_plane',
    generatedAt: context.generatedAt,
    ...(value.detail ? { detail: value.detail } : {}),
  };
}

function measured(value, evidenceRefs = [], detail = null) {
  return {
    status: 'measured',
    value: normalizeMetricValue(value),
    sampleSize: Array.isArray(evidenceRefs) ? evidenceRefs.length : 0,
    evidenceRefs: unique(evidenceRefs),
    detail,
  };
}

function ratio(numerator, denominator, evidenceRefs = []) {
  if (!denominator) {
    return measured(0, evidenceRefs, { numerator, denominator });
  }
  return measured(Number((numerator / denominator).toFixed(4)), evidenceRefs, { numerator, denominator });
}

function rateOrNotInstrumented(numerator, denominator, evidenceRefs = [], detail) {
  if (!denominator) return notInstrumented(detail);
  return ratio(numerator, denominator, evidenceRefs);
}

function durationAverage(samples) {
  if (!samples.length) return measured(0, [], { samples: 0 });
  return measured(Math.round(sum(samples.map((sample) => sample.durationMs)) / samples.length), evidenceIds(samples), { samples: samples.length });
}

function notInstrumented(detail) {
  return {
    status: 'not_instrumented',
    value: null,
    sampleSize: 0,
    evidenceRefs: [],
    source: 'instrumentation_gap',
    detail,
  };
}

function normalizeEvent(event = {}) {
  const details = event.details || {};
  const reasonCodes = unique([
    ...asArray(details.reasonCodes || details.reason_codes),
    ...asArray(details.decision?.reasonCodes || details.decision?.reason_codes),
  ]);
  return {
    ...event,
    details,
    reasonCodes,
    evidenceRefs: asArray(event.evidenceRefs),
  };
}

function normalizePolicyDecision(decision = {}) {
  return {
    ...decision,
    reasonCodes: asArray(decision.reasonCodes),
    decisionBody: decision.decisionBody || {},
  };
}

function normalizeInspectionRun(run = {}) {
  return {
    ...run,
    inspectionSignals: asArray(run.inspectionSignals),
    evidenceRefs: asArray(run.evidenceRefs),
  };
}

function normalizeTransaction(txn = {}) {
  return {
    ...txn,
    writeSet: asArray(txn.writeSet),
    observedWriteSet: asArray(txn.observedWriteSet),
    commitDecision: txn.commitDecision || null,
  };
}

function normalizeLease(lease = {}) {
  return {
    ...lease,
    lease: lease.lease || {},
  };
}

function normalizeIncident(incident = {}) {
  return {
    ...incident,
    incidentReplay: incident.incidentReplay || null,
    affectedZones: asArray(incident.affectedZones),
    evidenceRefs: asArray(incident.evidenceRefs),
  };
}

function normalizeCounterfactualRun(run = {}) {
  return {
    ...run,
    universes: asArray(run.universes),
    arbiterVerdict: run.arbiterVerdict || null,
    userChoice: run.userChoice || null,
    evidenceRefs: asArray(run.evidenceRefs),
  };
}

function eventsOfType(context, eventType) {
  return context.events.filter((event) => event.eventType === eventType);
}

function eventsWithReason(context, pattern) {
  return context.events.filter((event) => event.reasonCodes.some((code) => pattern.test(String(code))));
}

function policyDecisionsWithReason(context, pattern) {
  return context.policyDecisions.filter((decision) => decision.reasonCodes.some((code) => pattern.test(String(code))));
}

function isExplicitRerouteSignal(event) {
  const details = event.details || {};
  const reasonCodes = asArray(event.reasonCodes);
  if (reasonCodes.some((code) => /reroute|route_deviation|alternate_route|route_reassigned/i.test(String(code)))) return true;
  const actionText = [
    details.action,
    details.towerAction,
    details.tower_action,
    details.instructionType,
    details.instruction_type,
    details.type,
  ].map((value) => String(value || '').toLowerCase());
  if (actionText.some((value) => /reroute|alternate_route|route_reassigned/.test(value))) return true;
  return Boolean(
    details.reroutedFrom
    || details.rerouted_from
    || details.reroutedTo
    || details.rerouted_to
    || details.alternateRoute
    || details.alternate_route
    || (details.originalRoute && details.revisedRoute)
    || (details.original_route && details.revised_route)
  );
}

function inspectionSignals(run) {
  return asArray(run.inspectionSignals).map((signal, index) => ({
    ...signal,
    id: signal.id || `${run.id || 'inspection'}:signal:${index + 1}`,
    inspectionRunId: run.id,
  }));
}

function signalKey(signal) {
  const adapter = signal?.adapter;
  return String(
    signal?.key
    || signal?.signal
    || signal?.type
    || (typeof adapter === 'string' ? adapter : adapter?.key)
    || '',
  ).toLowerCase();
}

function signalFailed(signal) {
  return ['failed', 'failure', 'blocked', 'red', 'error'].includes(String(signal?.status || signal?.result || '').toLowerCase());
}

function inspectionFailed(run) {
  return ['failed', 'failure', 'blocked', 'go_around'].includes(String(run?.status || '').toLowerCase())
    || inspectionSignals(run).some(signalFailed);
}

function compareInspectionRuns(left, right) {
  return dateMs(left.requestedAt || left.completedAt) - dateMs(right.requestedAt || right.completedAt);
}

function clearanceDurations(context) {
  const plans = new Map(context.project.executionPlans.map((plan) => [plan.id, plan]));
  return context.leases
    .map((lease) => {
      const plan = plans.get(lease.executionPlanId);
      const durationMs = dateDiffMs(plan?.filedAt, lease.issuedAt);
      if (durationMs === null) return null;
      return { id: lease.id, durationMs };
    })
    .filter(Boolean);
}

function holdingDurations(context) {
  const now = dateMs(context.generatedAt);
  return [
    ...context.project.executionPlans
      .filter((plan) => String(plan.status || '').toLowerCase() === 'holding')
      .map((plan) => {
        const startedAt = dateMs(plan.filedAt);
        return startedAt ? { id: plan.id, durationMs: Math.max(0, now - startedAt) } : null;
      }),
    ...context.leases
      .filter((lease) => String(lease.status || '').toLowerCase() === 'holding')
      .map((lease) => {
        const startedAt = dateMs(lease.issuedAt);
        return startedAt ? { id: lease.id, durationMs: Math.max(0, now - startedAt) } : null;
      }),
  ].filter((sample) => sample && Number.isFinite(sample.durationMs));
}

function counterfactualUniverses(run) {
  return asArray(run.arbiterVerdict?.universes).length ? asArray(run.arbiterVerdict.universes) : asArray(run.universes);
}

function selectedCounterfactualUniverses(run) {
  const selected = run.arbiterVerdict?.selected || run.arbiterVerdict?.strategy;
  const universes = counterfactualUniverses(run);
  if (!selected) return universes.filter((universe) => String(universe.result || '').toLowerCase() === 'passed');
  return universes.filter((universe) => universe.strategy === selected);
}

function counterfactualReasonCodes(run) {
  return [
    ...asArray(run.arbiterVerdict?.reasonCodes),
    ...counterfactualUniverses(run).flatMap((universe) => asArray(universe.reasonCodes)),
  ];
}

function normalizeEventPaths(event) {
  if (!['write_allowed', 'transaction_committed'].includes(event.eventType)) return [];
  return unique([
    event.details?.path,
    ...asArray(event.details?.writeSet),
    ...asArray(event.details?.changedPaths),
  ].filter(Boolean).map(String));
}

function pathsOverlap(path, candidate) {
  if (!path || !candidate) return false;
  if (path === candidate) return true;
  const left = String(path).split('*')[0].replace(/\/+$/, '');
  const right = String(candidate).split('*')[0].replace(/\/+$/, '');
  return !left || !right || left.startsWith(right) || right.startsWith(left);
}

function evidenceIds(items) {
  return unique(asArray(items).flatMap((item) => [
    item?.id,
    item?.eventId,
    item?.replayDigest,
    item?.bundleDigest,
    ...asArray(item?.evidenceRefs),
  ]).filter(Boolean).map(String));
}

function uniqueIds(items) {
  return unique(asArray(items).map((item) => item?.id || item?.eventId || JSON.stringify(item)).filter(Boolean));
}

function uniqueWriteAttempts(events) {
  const groups = new Map();
  for (const event of asArray(events)) {
    const key = writeAttemptKey(event);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(event);
  }
  return [...groups.values()];
}

function writeAttemptKey(event) {
  const details = event?.details || {};
  const attemptId = details.attemptId || details.attempt_id || details.codesiteFsEvent?.attemptId || details.codesiteFsEvent?.attempt_id;
  if (attemptId) return `attempt:${attemptId}`;
  const path = details.path || details.codesiteFsEvent?.path;
  const transactionId = details.transactionId || details.transaction_id || event?.actorId;
  const leaseId = event?.mutationLeaseId || details.mutationLeaseId || details.mutation_lease_id || details.matchedLeaseId;
  if (path && (transactionId || leaseId)) return `write:${transactionId || ''}:${leaseId || ''}:${path}`;
  if (path) return `write-path:${event?.eventType}:${path}:${details.tool || details.codesiteFsEvent?.tool || ''}`;
  return event?.id || event?.eventId || JSON.stringify(event);
}

function uniqueBy(items, selector) {
  const seen = new Set();
  const output = [];
  for (const item of asArray(items)) {
    const key = selector(item);
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(item);
  }
  return output;
}

function noFlyViolationKey(item) {
  const attemptId = item?.details?.attemptId
    || item?.decisionBody?.attemptId
    || item?.decisionBody?.codesiteFsEvent?.attemptId;
  if (attemptId) return `nofly-attempt:${attemptId}`;
  const path = item?.details?.path
    || item?.decisionBody?.path
    || item?.decisionBody?.codesiteFsEvent?.path
    || item?.decisionBody?.details?.path;
  const mutationLeaseId = item?.mutationLeaseId || item?.decisionBody?.mutationLeaseId || '';
  if (path) return `nofly:${path}:${mutationLeaseId}`;
  return item?.id || item?.eventId || JSON.stringify(item);
}

function countBy(items, selector) {
  return asArray(items).reduce((acc, item) => {
    const key = selector(item);
    if (!key) return acc;
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

function groupBy(items, selector) {
  const map = new Map();
  for (const item of asArray(items)) {
    const key = selector(item);
    if (!map.has(key)) map.set(key, []);
    map.get(key).push(item);
  }
  return map;
}

function unique(values) {
  return [...new Set(asArray(values).filter(Boolean).map((value) => String(value)))];
}

function sum(values) {
  return asArray(values).reduce((total, value) => total + (Number(value) || 0), 0);
}

function normalizeMetricValue(value) {
  if (value == null) return null;
  const number = Number(value);
  if (!Number.isFinite(number)) return value;
  return Number.isInteger(number) ? number : Number(number.toFixed(4));
}

function dateMs(value) {
  const ms = Date.parse(value || '');
  return Number.isFinite(ms) ? ms : 0;
}

function dateDiffMs(start, end) {
  const startMs = dateMs(start);
  const endMs = dateMs(end);
  if (!startMs || !endMs || endMs < startMs) return null;
  return endMs - startMs;
}
