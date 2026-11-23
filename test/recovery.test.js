import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RecoveryController } from '../src/recovery.js';

const healthy = { probeSuccessRate: 0.99, errorRate: 0.001 };
const sick = { probeSuccessRate: 0.4, errorRate: 0.3 };

test('healthy probes advance one stage at a time, never a full dump', () => {
  const c = new RecoveryController();
  assert.equal(c.currentStage, 5);
  const first = c.evaluate(healthy);
  assert.equal(first.action, 'advance');
  assert.equal(first.stage, 25);
  const second = c.evaluate(healthy);
  assert.equal(second.stage, 50);
  const third = c.evaluate(healthy);
  assert.equal(third.stage, 100);
  assert.equal(c.evaluate(healthy).action, 'complete');
});

test('flapping probes roll back one stage and eventually halt the ramp', () => {
  const c = new RecoveryController({ maxFlaps: 3 });
  c.evaluate(healthy);
  c.evaluate(healthy);
  assert.equal(c.currentStage, 50);

  let r = c.evaluate(sick);
  assert.equal(r.action, 'rollback');
  assert.equal(r.stage, 25);
  assert.equal(r.flaps, 1);

  r = c.evaluate(sick);
  assert.equal(r.action, 'rollback');
  assert.equal(r.stage, 5);

  r = c.evaluate(sick);
  assert.equal(r.action, 'rollback');
  assert.equal(r.stage, 5, 'never rolls back below the canary stage');

  r = c.evaluate(sick);
  assert.equal(r.action, 'halt');
  assert.equal(r.reason, 'flap-limit-exceeded');
  assert.equal(c.evaluate(healthy).action, 'halted');
});

test('error rate above SLO blocks advancement even when probes pass', () => {
  const c = new RecoveryController({ maxErrorRate: 0.01 });
  const r = c.evaluate({ probeSuccessRate: 1, errorRate: 0.05 });
  assert.equal(r.action, 'rollback');
  assert.equal(c.currentStage, 5);
});

test('stages must be a strictly increasing ramp ending at 100', () => {
  assert.throws(() => new RecoveryController({ stages: [50, 10, 100] }), /increasing/);
  assert.throws(() => new RecoveryController({ stages: [10, 50] }), /end at 100/);
  assert.throws(() => new RecoveryController({ stages: [] }), /non-empty/);
});
