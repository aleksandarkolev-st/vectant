export const GPU_HMR_TEST_TIMING_SCHEMA = 'synthi.gpu_hmr.test_timing.v2';
export const GPU_HMR_TEST_TIMING_SCHEMA_VERSION = GPU_HMR_TEST_TIMING_SCHEMA;
export const GPU_HMR_TEST_TIMING_AUTHORITY = 'timing_only';
export const GPU_HMR_TEST_TIMING_CLOCK = 'monotonic_ns';

export const GPU_HMR_TEST_TIMING_PHASE_KEYS = Object.freeze([
  'cold_intake',
  'discovery',
  'split',
  'compile',
  'load',
  'epoch_publication',
  'dispatch',
  'output_ready',
  'trigger_to_visible',
  'screenshot_capture',
  'visual_analysis',
  'retirement',
  'proof_finalization',
  'total_wall',
]);

export const GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS = Object.freeze([
  'trigger_to_visible',
  'screenshot_capture',
  'visual_analysis',
]);

export const GPU_HMR_TEST_TIMING_PHASE_DEFINITIONS = Object.freeze({
  trigger_to_visible: Object.freeze({
    startsAt: 'post_edit_trigger',
    endsAt: 'first_post_edit_visible_or_output_ready_signal',
    excludes: Object.freeze([
      'screenshot_capture',
      'visual_analysis',
      'proof_finalization',
      'total_wall',
    ]),
  }),
});

export const GPU_HMR_TEST_TIMING_STATES = Object.freeze([
  'measured',
  'unavailable',
  'not_applicable',
]);

export const GPU_HMR_TEST_TIMING_OUTCOMES = Object.freeze([
  'pass',
  'refused',
  'failed',
]);

const PHASE_FIELDS = Object.freeze([
  'state',
  'startNs',
  'endNs',
  'durationNs',
  'reasonCode',
]);

const RECORD_FIELDS = Object.freeze([
  'schema',
  'schemaVersion',
  'clock',
  'authority',
  'timingOnly',
  'acceptedForGpuHmr',
  'gpuHmrSuccess',
  'outcome',
  'visualCapable',
  'complete',
  'blockingGaps',
  'completeness',
  'phases',
]);

const COMPLETENESS_FIELDS = Object.freeze([
  'complete',
  'blockingGaps',
]);

const PHASE_KEY_SET = new Set(GPU_HMR_TEST_TIMING_PHASE_KEYS);
const VISUAL_PHASE_KEY_SET = new Set(GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS);
const STATE_SET = new Set(GPU_HMR_TEST_TIMING_STATES);
const OUTCOME_SET = new Set(GPU_HMR_TEST_TIMING_OUTCOMES);
const CANONICAL_NS_PATTERN = /^(0|[1-9][0-9]*)$/;
const STABLE_REASON_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

function defaultClock() {
  return process.hrtime.bigint();
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function pushGap(gaps, gap) {
  if (!gaps.includes(gap)) gaps.push(gap);
}

function exactFieldGaps(value, expectedFields, scope, gaps) {
  if (!isObject(value)) {
    pushGap(gaps, `${scope}_not_object`);
    return false;
  }

  const actualFields = Object.keys(value);
  for (const field of expectedFields) {
    if (!Object.hasOwn(value, field)) {
      pushGap(gaps, `${scope}_field_missing:${field}`);
    }
  }
  for (const field of actualFields) {
    if (!expectedFields.includes(field)) {
      pushGap(gaps, `${scope}_field_unexpected:${field}`);
    }
  }
  return actualFields.length === expectedFields.length
    && expectedFields.every((field) => Object.hasOwn(value, field));
}

function arraysEqual(left, right) {
  return Array.isArray(left)
    && Array.isArray(right)
    && left.length === right.length
    && left.every((value, index) => value === right[index]);
}

function canonicalNs(value) {
  if (typeof value !== 'string' || !CANONICAL_NS_PATTERN.test(value)) return null;
  return BigInt(value);
}

function clockNs(value) {
  if (typeof value === 'bigint') {
    if (value < 0n) throw new GpuHmrTestTimingError('timing_clock_value_invalid');
    return value;
  }
  if (typeof value === 'string' && CANONICAL_NS_PATTERN.test(value)) {
    return BigInt(value);
  }
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) {
    return BigInt(value);
  }
  throw new GpuHmrTestTimingError('timing_clock_value_invalid');
}

export function isStableGpuHmrTimingReasonCode(value) {
  return typeof value === 'string' && STABLE_REASON_PATTERN.test(value);
}

function requireReasonCode(value, field = 'reasonCode') {
  if (!isStableGpuHmrTimingReasonCode(value)) {
    throw new GpuHmrTestTimingError('timing_reason_code_invalid', { field });
  }
  return value;
}

function measuredPhase(startNs, endNs) {
  return {
    state: 'measured',
    startNs: startNs.toString(),
    endNs: endNs.toString(),
    durationNs: (endNs - startNs).toString(),
    reasonCode: null,
  };
}

function reasonedPhase(state, reasonCode) {
  return {
    state,
    startNs: null,
    endNs: null,
    durationNs: null,
    reasonCode,
  };
}

function assessPhaseShape(phaseKey, phase, validationGaps) {
  const scope = `phase:${phaseKey}`;
  if (!exactFieldGaps(phase, PHASE_FIELDS, scope, validationGaps)) return null;

  if (!STATE_SET.has(phase.state)) {
    pushGap(validationGaps, `phase_state_invalid:${phaseKey}`);
    return null;
  }

  if (phase.state === 'measured') {
    const startNs = canonicalNs(phase.startNs);
    const endNs = canonicalNs(phase.endNs);
    const durationNs = canonicalNs(phase.durationNs);

    if (startNs === null) pushGap(validationGaps, `phase_start_ns_invalid:${phaseKey}`);
    if (endNs === null) pushGap(validationGaps, `phase_end_ns_invalid:${phaseKey}`);
    if (durationNs === null) pushGap(validationGaps, `phase_duration_ns_invalid:${phaseKey}`);
    if (phase.reasonCode !== null) {
      pushGap(validationGaps, `measured_phase_reason_must_be_null:${phaseKey}`);
    }

    if (startNs !== null && endNs !== null && endNs < startNs) {
      pushGap(validationGaps, `phase_timestamp_order_invalid:${phaseKey}`);
    }
    if (
      startNs !== null
      && endNs !== null
      && durationNs !== null
      && endNs >= startNs
      && durationNs !== endNs - startNs
    ) {
      pushGap(validationGaps, `phase_duration_mismatch:${phaseKey}`);
    }

    return { state: phase.state, startNs, endNs, durationNs };
  }

  if (!isStableGpuHmrTimingReasonCode(phase.reasonCode)) {
    pushGap(validationGaps, `phase_reason_code_invalid:${phaseKey}`);
  }
  for (const field of ['startNs', 'endNs', 'durationNs']) {
    if (phase[field] !== null) {
      pushGap(validationGaps, `reasoned_phase_timestamp_must_be_null:${phaseKey}:${field}`);
    }
  }
  return { state: phase.state, startNs: null, endNs: null, durationNs: null };
}

function assessPhases(phases, visualCapable) {
  const validationGaps = [];
  const completenessGaps = [];
  const parsed = new Map();

  if (!isObject(phases)) {
    return {
      validationGaps: ['phases_not_object'],
      completenessGaps: ['timing_phases_incomplete'],
    };
  }

  const actualKeys = Object.keys(phases);
  for (const phaseKey of GPU_HMR_TEST_TIMING_PHASE_KEYS) {
    if (!Object.hasOwn(phases, phaseKey)) {
      pushGap(validationGaps, `phase_missing:${phaseKey}`);
    }
  }
  for (const phaseKey of actualKeys) {
    if (!PHASE_KEY_SET.has(phaseKey)) {
      pushGap(validationGaps, `phase_unexpected:${phaseKey}`);
    }
  }

  for (const phaseKey of GPU_HMR_TEST_TIMING_PHASE_KEYS) {
    if (!Object.hasOwn(phases, phaseKey)) continue;
    const parsedPhase = assessPhaseShape(phaseKey, phases[phaseKey], validationGaps);
    if (parsedPhase !== null) parsed.set(phaseKey, parsedPhase);
    if (phases[phaseKey]?.state === 'unavailable') {
      pushGap(completenessGaps, `phase_unavailable:${phaseKey}`);
    }
  }

  const totalWall = parsed.get('total_wall');
  if (totalWall?.state !== 'measured') {
    pushGap(validationGaps, 'total_wall_must_be_measured');
  }

  if (
    totalWall?.state === 'measured'
    && totalWall.startNs !== null
    && totalWall.endNs !== null
    && totalWall.endNs >= totalWall.startNs
  ) {
    for (const phaseKey of GPU_HMR_TEST_TIMING_PHASE_KEYS) {
      if (phaseKey === 'total_wall') continue;
      const phase = parsed.get(phaseKey);
      if (
        phase?.state === 'measured'
        && phase.startNs !== null
        && phase.endNs !== null
        && (phase.startNs < totalWall.startNs || phase.endNs > totalWall.endNs)
      ) {
        pushGap(validationGaps, `phase_outside_total_wall:${phaseKey}`);
      }
    }
  }

  const completionBeforeStartEdges = [
    ['compile', 'load'],
    ['load', 'epoch_publication'],
    ['epoch_publication', 'dispatch'],
    ['dispatch', 'output_ready'],
    ['screenshot_capture', 'visual_analysis'],
  ];
  for (const [predecessorKey, successorKey] of completionBeforeStartEdges) {
    const predecessor = parsed.get(predecessorKey);
    const successor = parsed.get(successorKey);
    if (
      predecessor?.state === 'measured'
      && successor?.state === 'measured'
      && predecessor.endNs !== null
      && successor.startNs !== null
      && predecessor.endNs > successor.startNs
    ) {
      pushGap(
        validationGaps,
        `phase_causal_order_invalid:${predecessorKey}:${successorKey}`,
      );
    }
  }

  const proofFinalization = parsed.get('proof_finalization');
  const proofMustFinishAfter = ['retirement', 'output_ready'];
  if (visualCapable === true) proofMustFinishAfter.push('visual_analysis');
  for (const predecessorKey of proofMustFinishAfter) {
    const predecessor = parsed.get(predecessorKey);
    if (
      proofFinalization?.state === 'measured'
      && predecessor?.state === 'measured'
      && proofFinalization.endNs !== null
      && predecessor.endNs !== null
      && proofFinalization.endNs < predecessor.endNs
    ) {
      pushGap(
        validationGaps,
        `proof_finalization_finish_order_invalid:${predecessorKey}`,
      );
    }
  }

  if (visualCapable === true) {
    for (const phaseKey of GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS) {
      if (parsed.get(phaseKey)?.state !== 'measured') {
        pushGap(completenessGaps, `visual_phase_not_measured:${phaseKey}`);
      }
    }
  } else if (visualCapable === false) {
    for (const phaseKey of GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS) {
      if (parsed.get(phaseKey)?.state !== 'not_applicable') {
        pushGap(validationGaps, `nonvisual_phase_not_not_applicable:${phaseKey}`);
      }
    }
  }

  return { validationGaps, completenessGaps };
}

function freezeRecord(record) {
  for (const phase of Object.values(record.phases)) Object.freeze(phase);
  Object.freeze(record.phases);
  Object.freeze(record.blockingGaps);
  Object.freeze(record.completeness.blockingGaps);
  Object.freeze(record.completeness);
  return Object.freeze(record);
}

function finalizationOptions(value, visualCapable, terminalReason, notApplicableReason) {
  if (typeof value === 'string') {
    return {
      outcome: value,
      visualCapable,
      terminalReason: terminalReason ?? null,
      notApplicableReason: notApplicableReason ?? null,
    };
  }
  if (!isObject(value)) {
    throw new GpuHmrTestTimingError('timing_finalize_options_invalid');
  }
  return {
    outcome: value.outcome,
    visualCapable: value.visualCapable,
    terminalReason: value.terminalReason ?? value.terminalReasonCode ?? null,
    notApplicableReason: value.notApplicableReason
      ?? value.nonVisualReason
      ?? value.nonVisualReasonCode
      ?? null,
  };
}

export class GpuHmrTestTimingError extends Error {
  constructor(code, details = {}) {
    super(code);
    this.name = 'GpuHmrTestTimingError';
    this.code = code;
    this.details = Object.freeze({ ...details });
  }
}

export class GpuHmrTestTimingRecorder {
  #clock;
  #lastClockNs;
  #totalStartNs;
  #phaseTransitions;
  #finalized;
  #record;

  constructor(options = {}) {
    const normalizedOptions = typeof options === 'function' ? { clock: options } : options;
    if (!isObject(normalizedOptions)) {
      throw new GpuHmrTestTimingError('timing_recorder_options_invalid');
    }
    const clock = normalizedOptions.clock ?? normalizedOptions.nowNs ?? defaultClock;
    if (typeof clock !== 'function') {
      throw new GpuHmrTestTimingError('timing_clock_invalid');
    }

    this.#clock = clock;
    this.#lastClockNs = null;
    this.#totalStartNs = this.#readClock();
    this.#phaseTransitions = Object.fromEntries(
      GPU_HMR_TEST_TIMING_PHASE_KEYS
        .filter((phaseKey) => phaseKey !== 'total_wall')
        .map((phaseKey) => [phaseKey, { transition: 'untouched' }]),
    );
    this.#finalized = false;
    this.#record = null;
  }

  get isFinalized() {
    return this.#finalized;
  }

  get record() {
    return this.#record;
  }

  #readClock() {
    const reading = clockNs(this.#clock());
    if (this.#lastClockNs !== null && reading < this.#lastClockNs) {
      throw new GpuHmrTestTimingError('timing_clock_regressed');
    }
    this.#lastClockNs = reading;
    return reading;
  }

  #requireMutablePhase(phaseKey) {
    if (this.#finalized) {
      throw new GpuHmrTestTimingError('timing_recorder_finalized');
    }
    if (!PHASE_KEY_SET.has(phaseKey)) {
      throw new GpuHmrTestTimingError('timing_phase_unknown', { phaseKey });
    }
    if (phaseKey === 'total_wall') {
      throw new GpuHmrTestTimingError('timing_total_wall_managed_by_recorder');
    }
    return this.#phaseTransitions[phaseKey];
  }

  #requireTransition(phaseKey, expectedTransition) {
    const current = this.#requireMutablePhase(phaseKey);
    if (current.transition !== expectedTransition) {
      throw new GpuHmrTestTimingError('timing_phase_transition_invalid', {
        phaseKey,
        expectedTransition,
        actualTransition: current.transition,
      });
    }
    return current;
  }

  startPhase(phaseKey) {
    this.#requireTransition(phaseKey, 'untouched');
    const startNs = this.#readClock();
    this.#phaseTransitions[phaseKey] = { transition: 'started', startNs };
    return startNs.toString();
  }

  finishPhase(phaseKey) {
    const current = this.#requireTransition(phaseKey, 'started');
    const endNs = this.#readClock();
    const phase = measuredPhase(current.startNs, endNs);
    this.#phaseTransitions[phaseKey] = { transition: 'finished', phase };
    return Object.freeze({ ...phase });
  }

  unavailable(phaseKey, reasonCode) {
    this.#requireTransition(phaseKey, 'untouched');
    const phase = reasonedPhase('unavailable', requireReasonCode(reasonCode));
    this.#phaseTransitions[phaseKey] = { transition: 'finished', phase };
    return Object.freeze({ ...phase });
  }

  notApplicable(phaseKey, reasonCode) {
    this.#requireTransition(phaseKey, 'untouched');
    const phase = reasonedPhase('not_applicable', requireReasonCode(reasonCode));
    this.#phaseTransitions[phaseKey] = { transition: 'finished', phase };
    return Object.freeze({ ...phase });
  }

  start(phaseKey) {
    return this.startPhase(phaseKey);
  }

  finish(phaseKey) {
    return this.finishPhase(phaseKey);
  }

  markUnavailable(phaseKey, reasonCode) {
    return this.unavailable(phaseKey, reasonCode);
  }

  markNotApplicable(phaseKey, reasonCode) {
    return this.notApplicable(phaseKey, reasonCode);
  }

  phaseStart(phaseKey) {
    return this.startPhase(phaseKey);
  }

  phaseFinish(phaseKey) {
    return this.finishPhase(phaseKey);
  }

  markPhaseUnavailable(phaseKey, reasonCode) {
    return this.unavailable(phaseKey, reasonCode);
  }

  markPhaseNotApplicable(phaseKey, reasonCode) {
    return this.notApplicable(phaseKey, reasonCode);
  }

  finalize(value, visualCapable, terminalReason, notApplicableReason) {
    if (this.#finalized) {
      throw new GpuHmrTestTimingError('timing_recorder_finalized');
    }

    const options = finalizationOptions(
      value,
      visualCapable,
      terminalReason,
      notApplicableReason,
    );
    if (!OUTCOME_SET.has(options.outcome)) {
      throw new GpuHmrTestTimingError('timing_outcome_invalid');
    }
    if (typeof options.visualCapable !== 'boolean') {
      throw new GpuHmrTestTimingError('timing_visual_capable_invalid');
    }
    if (options.terminalReason !== null) {
      requireReasonCode(options.terminalReason, 'terminalReason');
    }
    if (options.notApplicableReason !== null) {
      requireReasonCode(options.notApplicableReason, 'notApplicableReason');
    }

    const staged = Object.fromEntries(
      Object.entries(this.#phaseTransitions).map(([phaseKey, transition]) => [
        phaseKey,
        { ...transition },
      ]),
    );

    if (options.visualCapable === false) {
      const visualReason = options.notApplicableReason ?? options.terminalReason;
      for (const phaseKey of GPU_HMR_TEST_TIMING_VISUAL_PHASE_KEYS) {
        if (staged[phaseKey].transition === 'finished') {
          if (staged[phaseKey].phase.state !== 'not_applicable') {
            throw new GpuHmrTestTimingError('timing_nonvisual_phase_state_invalid', {
              phaseKey,
              state: staged[phaseKey].phase.state,
            });
          }
          continue;
        }
        if (staged[phaseKey].transition === 'started') {
          throw new GpuHmrTestTimingError('timing_nonvisual_phase_state_invalid', {
            phaseKey,
            state: 'started',
          });
        }
        if (visualReason === null) {
          throw new GpuHmrTestTimingError('timing_not_applicable_reason_required', {
            phaseKey,
          });
        }
        staged[phaseKey] = {
          transition: 'finished',
          phase: reasonedPhase('not_applicable', visualReason),
        };
      }
    }

    const untouchedPhaseKeys = Object.entries(staged)
      .filter(([, transition]) => transition.transition === 'untouched')
      .map(([phaseKey]) => phaseKey);
    if (untouchedPhaseKeys.length > 0 && options.terminalReason === null) {
      throw new GpuHmrTestTimingError('timing_terminal_reason_required', {
        phaseKeys: untouchedPhaseKeys,
      });
    }
    for (const phaseKey of untouchedPhaseKeys) {
      staged[phaseKey] = {
        transition: 'finished',
        phase: reasonedPhase('unavailable', options.terminalReason),
      };
    }

    const totalEndNs = this.#readClock();
    for (const [phaseKey, transition] of Object.entries(staged)) {
      if (transition.transition !== 'started') continue;
      staged[phaseKey] = {
        transition: 'finished',
        phase: measuredPhase(transition.startNs, totalEndNs),
      };
    }
    const phases = Object.fromEntries([
      ...GPU_HMR_TEST_TIMING_PHASE_KEYS
        .filter((phaseKey) => phaseKey !== 'total_wall')
        .map((phaseKey) => [phaseKey, { ...staged[phaseKey].phase }]),
      ['total_wall', measuredPhase(this.#totalStartNs, totalEndNs)],
    ]);

    const phaseAssessment = assessPhases(phases, options.visualCapable);
    const blockingGaps = [
      ...phaseAssessment.validationGaps,
      ...phaseAssessment.completenessGaps,
    ];
    const complete = blockingGaps.length === 0;
    const record = {
      schema: GPU_HMR_TEST_TIMING_SCHEMA,
      schemaVersion: GPU_HMR_TEST_TIMING_SCHEMA_VERSION,
      clock: GPU_HMR_TEST_TIMING_CLOCK,
      authority: GPU_HMR_TEST_TIMING_AUTHORITY,
      timingOnly: true,
      acceptedForGpuHmr: false,
      gpuHmrSuccess: false,
      outcome: options.outcome,
      visualCapable: options.visualCapable,
      complete,
      blockingGaps: [...blockingGaps],
      completeness: {
        complete,
        blockingGaps: [...blockingGaps],
      },
      phases,
    };

    this.#phaseTransitions = staged;
    this.#finalized = true;
    this.#record = freezeRecord(record);
    return this.#record;
  }
}

export function createGpuHmrTestTimingRecorder(options) {
  return new GpuHmrTestTimingRecorder(options);
}

export function validateGpuHmrTestTiming(record) {
  const validationGaps = [];
  let completenessGaps = [];

  if (!exactFieldGaps(record, RECORD_FIELDS, 'record', validationGaps)) {
    if (!isObject(record)) {
      return Object.freeze({
        valid: false,
        complete: false,
        ok: false,
        validationGaps: Object.freeze([...validationGaps]),
        completenessGaps: Object.freeze([]),
        blockingGaps: Object.freeze([...validationGaps]),
      });
    }
  }

  if (record.schema !== GPU_HMR_TEST_TIMING_SCHEMA) {
    pushGap(validationGaps, 'schema_invalid');
  }
  if (record.schemaVersion !== GPU_HMR_TEST_TIMING_SCHEMA_VERSION) {
    pushGap(validationGaps, 'schema_version_invalid');
  }
  if (record.clock !== GPU_HMR_TEST_TIMING_CLOCK) {
    pushGap(validationGaps, 'clock_invalid');
  }
  if (record.authority !== GPU_HMR_TEST_TIMING_AUTHORITY) {
    pushGap(validationGaps, 'timing_authority_invalid');
  }
  if (record.timingOnly !== true) {
    pushGap(validationGaps, 'timing_only_must_be_true');
  }
  if (record.acceptedForGpuHmr !== false) {
    pushGap(validationGaps, 'accepted_for_gpu_hmr_must_be_false');
  }
  if (record.gpuHmrSuccess !== false) {
    pushGap(validationGaps, 'gpu_hmr_success_must_be_false');
  }
  if (!OUTCOME_SET.has(record.outcome)) {
    pushGap(validationGaps, 'outcome_invalid');
  }
  if (typeof record.visualCapable !== 'boolean') {
    pushGap(validationGaps, 'visual_capable_invalid');
  }

  const phaseAssessment = assessPhases(
    record.phases,
    typeof record.visualCapable === 'boolean' ? record.visualCapable : null,
  );
  for (const gap of phaseAssessment.validationGaps) pushGap(validationGaps, gap);
  completenessGaps = [...phaseAssessment.completenessGaps];

  const substantiveBlockingGaps = [...validationGaps, ...completenessGaps];
  const substantiveComplete = substantiveBlockingGaps.length === 0;

  if (record.complete !== substantiveComplete) {
    pushGap(validationGaps, 'complete_declaration_mismatch');
  }
  if (!arraysEqual(record.blockingGaps, substantiveBlockingGaps)) {
    pushGap(validationGaps, 'blocking_gaps_declaration_mismatch');
  }

  if (exactFieldGaps(record.completeness, COMPLETENESS_FIELDS, 'completeness', validationGaps)) {
    if (record.completeness.complete !== substantiveComplete) {
      pushGap(validationGaps, 'completeness_complete_mismatch');
    }
    if (!arraysEqual(record.completeness.blockingGaps, substantiveBlockingGaps)) {
      pushGap(validationGaps, 'completeness_blocking_gaps_mismatch');
    }
  }

  const blockingGaps = [...validationGaps];
  for (const gap of completenessGaps) pushGap(blockingGaps, gap);
  const valid = validationGaps.length === 0;
  const complete = valid && completenessGaps.length === 0;

  return Object.freeze({
    valid,
    complete,
    ok: complete,
    validationGaps: Object.freeze([...validationGaps]),
    completenessGaps: Object.freeze([...completenessGaps]),
    blockingGaps: Object.freeze(blockingGaps),
  });
}

export function assertValidGpuHmrTestTiming(record) {
  const validation = validateGpuHmrTestTiming(record);
  if (!validation.valid) {
    throw new GpuHmrTestTimingError('timing_record_invalid', {
      blockingGaps: validation.blockingGaps,
    });
  }
  return validation;
}

export function assertCompleteGpuHmrTestTiming(record) {
  const validation = validateGpuHmrTestTiming(record);
  if (!validation.complete) {
    throw new GpuHmrTestTimingError('timing_record_incomplete', {
      blockingGaps: validation.blockingGaps,
    });
  }
  return validation;
}

export const createGpuHmrTestTimingV2Recorder = createGpuHmrTestTimingRecorder;
export const validateGpuHmrTestTimingV2 = validateGpuHmrTestTiming;
export const validateGpuHmrTestTimingRecord = validateGpuHmrTestTiming;
export { GpuHmrTestTimingRecorder as GpuHmrTestTimingV2Recorder };
