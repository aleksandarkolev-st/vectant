import assert from 'node:assert/strict';

import {
  createColdBuildExecutionPlanReceipt,
} from '../lib/gpu-hmr-cold-build-execution-plan.mjs';

let getterCalls = 0;
const accessorImpostor = {};
Object.defineProperty(accessorImpostor, 'planHash', {
  enumerable: true,
  get() {
    getterCalls += 1;
    throw new Error('unbranded plan getter must not run');
  },
});
assert.throws(
  () => createColdBuildExecutionPlanReceipt(accessorImpostor),
  /cold_build_execution_plan_receipt_source_invalid/,
);

const proxyImpostor = new Proxy({}, {
  get() {
    getterCalls += 1;
    throw new Error('unbranded plan proxy must not run');
  },
});
assert.throws(
  () => createColdBuildExecutionPlanReceipt(proxyImpostor),
  /cold_build_execution_plan_receipt_source_invalid/,
);

const revocableImpostor = Proxy.revocable({}, {});
revocableImpostor.revoke();
assert.throws(
  () => createColdBuildExecutionPlanReceipt(revocableImpostor.proxy),
  /cold_build_execution_plan_receipt_source_invalid/,
);
assert.equal(getterCalls, 0);

console.log('gpu-hmr cold build execution plan receipt self-check passed');
