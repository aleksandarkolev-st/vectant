/**
 * Synthi Extension System - Comprehensive Test Suite
 * PART 2: Tests from user requirements
 * 
 * Tests:
 * A. State machine invariants
 * B. Livelock test
 * C. Cross-extension interference test
 * D. Restart storm test
 * E. Long-session soak test (manual)
 * F. Webview isolation test
 * G. Kill-switch verification
 */

import {
  ExtensionState,
  StableState,
  TransientState,
  isValidTransition,
  assertValidTransition,
  isStableState,
  isTransientState,
  getStateForPersistence,
  createExtensionStateRecord,
  VALID_TRANSITIONS,
  TRANSIENT_TIMEOUTS
} from './ExtensionState.js';

import { createExtensionStateReducer, ActionType, createAction } from './ExtensionStateReducer.js';
import { createRestartFence, WorkerState, RejectionReason } from './RestartFence.js';
import { createFairScheduler } from './CrossExtensionIsolation.js';
import { createRuntimeAPIEnforcer, APISupport } from './RuntimeAPIEnforcer.js';
import { LivelockDetector } from './LivelockDetector.js';

/**
 * Test results collector
 */
class TestRunner {
  constructor() {
    this.results = [];
    this.currentSuite = null;
  }

  suite(name) {
    this.currentSuite = name;
    console.log(`\n========== ${name} ==========`);
  }

  test(name, fn) {
    const fullName = this.currentSuite ? `${this.currentSuite}: ${name}` : name;
    try {
      fn();
      this.results.push({ name: fullName, passed: true });
      console.log(`✓ ${name}`);
    } catch (err) {
      this.results.push({ name: fullName, passed: false, error: err.message });
      console.error(`✗ ${name}: ${err.message}`);
    }
  }

  async testAsync(name, fn) {
    const fullName = this.currentSuite ? `${this.currentSuite}: ${name}` : name;
    try {
      await fn();
      this.results.push({ name: fullName, passed: true });
      console.log(`✓ ${name}`);
    } catch (err) {
      this.results.push({ name: fullName, passed: false, error: err.message });
      console.error(`✗ ${name}: ${err.message}`);
    }
  }

  assert(condition, message) {
    if (!condition) {
      throw new Error(message || 'Assertion failed');
    }
  }

  assertEqual(actual, expected, message) {
    if (actual !== expected) {
      throw new Error(message || `Expected ${expected}, got ${actual}`);
    }
  }

  assertThrows(fn, message) {
    let threw = false;
    try {
      fn();
    } catch (e) {
      threw = true;
    }
    if (!threw) {
      throw new Error(message || 'Expected function to throw');
    }
  }

  summary() {
    const passed = this.results.filter(r => r.passed).length;
    const failed = this.results.filter(r => !r.passed).length;
    
    console.log(`\n========== SUMMARY ==========`);
    console.log(`Passed: ${passed}/${this.results.length}`);
    console.log(`Failed: ${failed}/${this.results.length}`);
    
    if (failed > 0) {
      console.log(`\nFailed tests:`);
      for (const r of this.results.filter(r => !r.passed)) {
        console.log(`  - ${r.name}: ${r.error}`);
      }
    }
    
    return { passed, failed, total: this.results.length };
  }
}

// ============================================================================
// A. STATE MACHINE INVARIANT TESTS
// ============================================================================

export function runStateMachineTests(runner) {
  runner.suite('A. State Machine Invariants');

  // Test: Impossible transitions throw
  runner.test('Impossible transitions throw', () => {
    // QUARANTINED -> ACTIVE is impossible
    runner.assertThrows(() => {
      assertValidTransition(StableState.QUARANTINED, StableState.ACTIVE);
    }, 'QUARANTINED -> ACTIVE should throw');

    // DISABLED -> ACTIVE is impossible
    runner.assertThrows(() => {
      assertValidTransition(StableState.DISABLED, StableState.ACTIVE);
    }, 'DISABLED -> ACTIVE should throw');

    // INSTALLED -> ACTIVE is impossible (must go through LOADED -> ACTIVATING)
    runner.assertThrows(() => {
      assertValidTransition(StableState.INSTALLED, StableState.ACTIVE);
    }, 'INSTALLED -> ACTIVE should throw');
  });

  // Test: Transient states never persist
  runner.test('Transient states never persist', () => {
    for (const state of Object.values(TransientState)) {
      runner.assert(isTransientState(state), `${state} should be transient`);
      runner.assert(!isStableState(state), `${state} should not be stable`);
    }
    
    // getStateForPersistence should never return transient
    const record = createExtensionStateRecord('test', {}, '');
    record.state = TransientState.ACTIVATING;
    record.previousState = StableState.LOADED;
    
    const persisted = getStateForPersistence(record);
    runner.assert(isStableState(persisted), `Persisted state should be stable, got ${persisted}`);
  });

  // Test: CRASHING must end in ACTIVE or QUARANTINED
  runner.test('CRASHING only transitions to ACTIVE or QUARANTINED', () => {
    const allowed = VALID_TRANSITIONS[TransientState.CRASHING];
    runner.assert(allowed.length === 2, 'CRASHING should have exactly 2 transitions');
    runner.assert(allowed.includes(StableState.ACTIVE), 'CRASHING must allow -> ACTIVE');
    runner.assert(allowed.includes(StableState.QUARANTINED), 'CRASHING must allow -> QUARANTINED');
  });

  // Test: Quarantined extensions cannot activate
  runner.test('Quarantined extensions cannot activate', () => {
    const reducer = createExtensionStateReducer();
    
    // Register and quarantine an extension
    reducer.dispatch(createAction(ActionType.REGISTER, 'test-ext', {
      manifest: { name: 'Test' },
      code: 'console.log("test")'
    }));
    reducer.dispatch(createAction(ActionType.QUARANTINE, 'test-ext', {
      reason: 'Test quarantine'
    }));

    // Try to activate
    const result = reducer.canActivate('test-ext');
    runner.assert(!result.canActivate, 'Quarantined extension should not be activatable');
    runner.assert(result.reason.includes('quarantine'), 'Reason should mention quarantine');
  });

  // Test: Restart does not resurrect quarantined extensions
  runner.test('Restart does not resurrect quarantined extensions', () => {
    const reducer = createExtensionStateReducer();
    
    // Register and quarantine
    reducer.dispatch(createAction(ActionType.REGISTER, 'bad-ext', {
      manifest: { name: 'Bad' },
      code: 'while(true){}'
    }));
    reducer.dispatch(createAction(ActionType.QUARANTINE, 'bad-ext', {
      reason: 'Infinite loop'
    }));

    // Simulate worker restart
    reducer.dispatch(createAction(ActionType.WORKER_DIED, null, {}));
    reducer.dispatch(createAction(ActionType.WORKER_RESTARTED, null, {}));

    // Check extension is still quarantined
    const ext = reducer.getExtension('bad-ext');
    runner.assertEqual(ext.state, StableState.QUARANTINED, 'Should still be quarantined after restart');
  });

  // Test: All stable states are properly identified
  runner.test('Stable states are correctly identified', () => {
    for (const state of Object.values(StableState)) {
      runner.assert(isStableState(state), `${state} should be stable`);
    }
  });

  // Test: Transient states have timeouts defined
  runner.test('All transient states have timeouts', () => {
    for (const state of Object.values(TransientState)) {
      runner.assert(TRANSIENT_TIMEOUTS[state], `${state} should have timeout config`);
      runner.assert(TRANSIENT_TIMEOUTS[state].timeoutMs > 0, `${state} timeout should be positive`);
      runner.assert(isStableState(TRANSIENT_TIMEOUTS[state].forceState), 
        `${state} force state should be stable`);
    }
  });
}

// ============================================================================
// B. LIVELOCK TEST
// ============================================================================

export function runLivelockTests(runner) {
  runner.suite('B. Livelock Detection');

  runner.test('Drift detection triggers on late heartbeat', () => {
    let livelockTriggered = false;
    
    const detector = new LivelockDetector({
      heartbeatInterval: 100,
      maxDriftMultiplier: 2,
      onLivelock: (reason) => {
        livelockTriggered = true;
      }
    });

    detector.start();
    
    // Simulate a very late heartbeat (> 2x interval)
    const result = detector.recordHeartbeat('test-ext');
    
    // First heartbeat is baseline, simulate time passing
    detector.expectedNextHeartbeat = Date.now() - 300; // 300ms late
    const lateResult = detector.recordHeartbeat('test-ext');
    
    runner.assert(!lateResult.healthy || livelockTriggered, 
      'Should detect unhealthy state or trigger livelock');
    
    detector.stop();
  });

  runner.test('Normal heartbeats pass health check', () => {
    const detector = new LivelockDetector({
      heartbeatInterval: 5000,
      maxDriftMultiplier: 2
    });

    detector.start();
    
    // Record a heartbeat
    const result = detector.recordHeartbeat();
    
    runner.assert(result.healthy, 'Immediate heartbeat should be healthy');
    runner.assert(result.drift < 1000, 'Drift should be minimal');
    
    detector.stop();
  });

  runner.test('Status reflects current health', () => {
    const detector = new LivelockDetector({
      heartbeatInterval: 5000
    });

    detector.start();
    detector.recordHeartbeat();
    
    const status = detector.getStatus();
    runner.assert(status.healthy, 'Should be healthy after recent heartbeat');
    runner.assertEqual(status.missedCount, 0, 'Should have no missed heartbeats');
    
    detector.stop();
  });
}

// ============================================================================
// C. CROSS-EXTENSION INTERFERENCE TEST
// ============================================================================

export async function runCrossExtensionTests(runner) {
  runner.suite('C. Cross-Extension Isolation');

  await runner.testAsync('Extension A cannot starve Extension B', async () => {
    const scheduler = createFairScheduler({
      messagesPerSecond: 10,
      cpuBudgetMs: 100
    });

    scheduler.registerExtension('ext-a');
    scheduler.registerExtension('ext-b');

    let aProcessed = 0;
    let bProcessed = 0;

    scheduler.onProcess = async (entry, extId) => {
      if (extId === 'ext-a') aProcessed++;
      if (extId === 'ext-b') bProcessed++;
      // Simulate some work
      await new Promise(r => setTimeout(r, 1));
    };

    // A floods with messages
    for (let i = 0; i < 100; i++) {
      scheduler.queueMessage('ext-a', 'flood', { i });
    }

    // B sends a few messages
    for (let i = 0; i < 5; i++) {
      scheduler.queueMessage('ext-b', 'normal', { i });
    }

    // Process some messages
    for (let i = 0; i < 20; i++) {
      await scheduler.processNext();
    }

    // B should have gotten fair share
    runner.assert(bProcessed >= 3, `Extension B should process at least 3 messages, got ${bProcessed}`);
    runner.assert(aProcessed > 0, 'Extension A should also process some');
  });

  await runner.testAsync('Throttling kicks in on message flood', async () => {
    const scheduler = createFairScheduler({
      messagesPerSecond: 5, // Very low limit
      cpuBudgetMs: 100
    });

    scheduler.registerExtension('flooder');

    let throttleCount = 0;
    scheduler.onThrottled = (extId, reason) => {
      throttleCount++;
    };

    // Send more messages than allowed
    for (let i = 0; i < 20; i++) {
      scheduler.queueMessage('flooder', 'spam', { i });
    }

    runner.assert(throttleCount > 0, `Should have been throttled, got ${throttleCount} throttle events`);
  });

  runner.test('Per-extension rate limiting', () => {
    const scheduler = createFairScheduler({
      messagesPerSecond: 3
    });

    scheduler.registerExtension('limited');

    // First 3 should succeed
    for (let i = 0; i < 3; i++) {
      const result = scheduler.queueMessage('limited', 'msg', { i });
      runner.assert(result.success, `Message ${i} should queue`);
    }

    // 4th should be rate limited
    const result = scheduler.queueMessage('limited', 'msg', { i: 4 });
    runner.assert(!result.success, 'Message should be rate limited');
    runner.assert(result.error.includes('Rate limit'), 'Error should mention rate limit');
  });
}

// ============================================================================
// D. RESTART STORM TEST  
// ============================================================================

export function runRestartStormTests(runner) {
  runner.suite('D. Restart Storm Prevention');

  runner.test('Generation increments atomically on restart', () => {
    const fence = createRestartFence();
    
    const gen1 = fence.generation;
    fence.beginRestart();
    const gen2 = fence.generation;
    
    runner.assertEqual(gen2, gen1 + 1, 'Generation should increment by 1');
    
    fence.completeRestart();
    fence.beginRestart();
    const gen3 = fence.generation;
    
    runner.assertEqual(gen3, gen2 + 1, 'Generation should increment again');
  });

  runner.test('In-flight RPCs are rejected on restart', async () => {
    const fence = createRestartFence();
    fence.markRunning();

    let rejectedCount = 0;
    fence.onRpcRejected = () => rejectedCount++;

    // Register some RPCs
    await fence.registerRpc('test1', 'ext1');
    await fence.registerRpc('test2', 'ext2');
    await fence.registerRpc('test3', 'ext3');

    runner.assertEqual(fence.inFlightCount, 3, 'Should have 3 in-flight RPCs');

    // Trigger restart
    fence.beginRestart();

    runner.assertEqual(fence.inFlightCount, 0, 'All RPCs should be cleared');
    runner.assertEqual(rejectedCount, 3, 'All RPCs should be rejected');
  });

  runner.test('No messages accepted during RESTARTING state', () => {
    const fence = createRestartFence();
    fence.markRunning();
    fence.beginRestart();

    const check = fence.canSendMessage();
    runner.assert(!check.canSend, 'Should not be able to send during restart');
    runner.assert(check.reason.includes('restart'), 'Reason should mention restart');
  });

  runner.test('Stale generation responses are rejected', async () => {
    const fence = createRestartFence();
    fence.markRunning();

    const { id, generation } = await fence.registerRpc('test', 'ext');
    
    // Restart (increments generation)
    fence.beginRestart();
    fence.completeRestart();

    // Try to complete with old generation
    const completed = fence.completeRpc(id, generation, 'result');
    runner.assert(!completed, 'Should reject stale generation response');
  });
}

// ============================================================================
// F. WEBVIEW ISOLATION TEST (Simulated)
// ============================================================================

export function runWebviewIsolationTests(runner) {
  runner.suite('F. Message Isolation');

  runner.test('Queue overflow drops messages', () => {
    const scheduler = createFairScheduler({
      maxQueueSize: 5
    });

    scheduler.registerExtension('spammer');

    // Fill queue
    for (let i = 0; i < 10; i++) {
      scheduler.queueMessage('spammer', 'spam', { i });
    }

    const stats = scheduler.getStats().get('spammer');
    runner.assert(stats.queue.dropped > 0, 'Should have dropped messages');
    runner.assert(stats.queue.size <= 5, 'Queue should not exceed max size');
  });
}

// ============================================================================
// G. KILL-SWITCH VERIFICATION
// ============================================================================

export function runKillSwitchTests(runner) {
  runner.suite('G. Kill-Switch Verification');

  runner.test('All pending calls rejected on worker death', async () => {
    const fence = createRestartFence();
    fence.markRunning();

    let rejections = 0;
    fence.onRpcRejected = (rpc, reason) => {
      if (reason === RejectionReason.WORKER_DEAD) {
        rejections++;
      }
    };

    // Register RPCs
    await fence.registerRpc('call1', 'ext1');
    await fence.registerRpc('call2', 'ext2');

    // Kill worker
    fence.markDead();

    runner.assertEqual(rejections, 2, 'All RPCs should be rejected with WORKER_DEAD');
    runner.assertEqual(fence.state, WorkerState.DEAD, 'State should be DEAD');
  });

  runner.test('Fence blocks new messages after kill', () => {
    const fence = createRestartFence();
    fence.markRunning();
    fence.markDead();

    const check = fence.canSendMessage();
    runner.assert(!check.canSend, 'Should not be able to send to dead worker');
  });

  runner.test('State recovers after restart', () => {
    const fence = createRestartFence();
    fence.markDead();
    fence.beginRestart();
    fence.completeRestart();

    runner.assertEqual(fence.state, WorkerState.RUNNING, 'Should be running after restart');
    runner.assert(!fence.isFenced, 'Fence should be down');
    runner.assert(fence.canSendMessage().canSend, 'Should be able to send');
  });
}

// ============================================================================
// RUNTIME API ENFORCEMENT TESTS
// ============================================================================

export function runAPIEnforcementTests(runner) {
  runner.suite('Runtime API Enforcement');

  runner.test('Stable APIs are allowed', () => {
    const enforcer = createRuntimeAPIEnforcer();
    
    const result = enforcer.checkAccess('test-ext', 'vscode.commands.registerCommand');
    runner.assert(result.allowed, 'Stable API should be allowed');
    runner.assertEqual(result.level, APISupport.STABLE, 'Should be STABLE');
  });

  runner.test('Forbidden APIs throw immediately', () => {
    const enforcer = createRuntimeAPIEnforcer();

    runner.assertThrows(() => {
      enforcer.enforceAccess('test-ext', 'eval');
    }, 'eval should throw');

    runner.assertThrows(() => {
      enforcer.enforceAccess('test-ext', 'child_process');
    }, 'child_process should throw');
  });

  runner.test('Not implemented APIs throw', () => {
    const enforcer = createRuntimeAPIEnforcer();

    runner.assertThrows(() => {
      enforcer.enforceAccess('test-ext', 'vscode.debug.startDebugging');
    }, 'Debug API should throw');
  });

  runner.test('3 violations trigger quarantine recommendation', () => {
    let quarantineTriggered = false;
    
    const enforcer = createRuntimeAPIEnforcer({
      maxViolationsBeforeQuarantine: 3,
      onQuarantine: (extId, reason) => {
        quarantineTriggered = true;
        runner.assertEqual(extId, 'bad-ext', 'Should identify correct extension');
      }
    });

    // Cause 3 violations
    try { enforcer.enforceAccess('bad-ext', 'vscode.debug.startDebugging'); } catch {}
    try { enforcer.enforceAccess('bad-ext', 'vscode.debug.stopDebugging'); } catch {}
    try { enforcer.enforceAccess('bad-ext', 'vscode.tasks.executeTask'); } catch {}

    runner.assert(quarantineTriggered, 'Quarantine should be triggered after 3 violations');
  });

  runner.test('Experimental APIs log but allow', () => {
    const enforcer = createRuntimeAPIEnforcer();

    const result = enforcer.checkAccess('test-ext', 'vscode.languages.registerCompletionItemProvider');
    runner.assert(result.allowed, 'Experimental API should be allowed');
    runner.assertEqual(result.level, APISupport.EXPERIMENTAL, 'Should be marked experimental');
  });
}

// ============================================================================
// RUN ALL TESTS
// ============================================================================

export async function runAllTests() {
  const runner = new TestRunner();

  console.log('Starting Synthi Extension System Test Suite\n');
  console.log('============================================\n');

  // A. State Machine
  runStateMachineTests(runner);

  // B. Livelock
  runLivelockTests(runner);

  // C. Cross-Extension (async)
  await runCrossExtensionTests(runner);

  // D. Restart Storm
  runRestartStormTests(runner);

  // F. Webview Isolation
  runWebviewIsolationTests(runner);

  // G. Kill-Switch
  runKillSwitchTests(runner);

  // API Enforcement
  runAPIEnforcementTests(runner);

  return runner.summary();
}

// Export for browser/Node usage
if (typeof window !== 'undefined') {
  window.runExtensionSystemTests = runAllTests;
}
