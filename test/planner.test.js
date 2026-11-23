import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planContainment } from '../src/planner.js';

const slo = { maxErrorRate: 0.01 };

function sharedCacheScenario() {
  return {
    name: 'shared-cache',
    slo,
    nodes: {
      api: {
        kind: 'service',
        critical: true,
        currentRps: 500,
        dependsOn: ['cache', 'db'],
        retries: { maxAttempts: 3 },
        fallbacks: { cache: 'db' },
      },
      worker: {
        kind: 'service',
        critical: false,
        currentRps: 200,
        dependsOn: ['cache', 'db'],
        retries: { maxAttempts: 2 },
      },
      cache: { kind: 'dependency', shared: true, capacityRps: 5000, errorRate: 0.9 },
      db: { kind: 'dependency', capacityRps: 1200, errorRate: 0.002 },
    },
    isolationSwitches: [{ id: 'shed-worker', shedsRps: { worker: 100 } }],
    recoveryProbes: [{ id: 'cache-probe', target: 'cache', successThreshold: 0.95 }],
  };
}

test('shared dependency failure opens breakers at every caller and sizes blast radius', () => {
  const plan = planContainment(sharedCacheScenario());
  assert.deepEqual(plan.impactScope.faultedDependencies, ['cache']);
  assert.deepEqual(plan.impactScope.affectedServices, ['api', 'worker']);
  assert.deepEqual(plan.impactScope.criticalServicesAffected, ['api']);

  const breakers = plan.actions.filter((a) => a.type === 'circuit-breaker');
  assert.deepEqual(
    breakers.map((b) => b.target).sort(),
    ['api', 'worker'],
  );
  assert.ok(breakers.every((b) => b.params.state === 'open'));
});

test('upstream degradation must not crush the remaining dependency', () => {
  const plan = planContainment(sharedCacheScenario());
  const degrade = plan.actions.find(
    (a) => a.type === 'degrade' && a.target === 'api' && a.dependency === 'cache',
  );
  assert.equal(degrade.params.mode, 'fail-fast');

  const guard = plan.actions.find(
    (a) => a.type === 'rate-limit' && a.dependency === 'db' && a.target === 'api',
  );
  assert.ok(guard, 'expected a rate limit guarding db');
  assert.ok(guard.params.maxRps <= 1200 * 0.9);
});

test('fallback is allowed when the remaining dependency has headroom', () => {
  const scenario = sharedCacheScenario();
  scenario.nodes.db.capacityRps = 100000;
  const plan = planContainment(scenario);
  const degrade = plan.actions.find(
    (a) => a.type === 'degrade' && a.target === 'api' && a.dependency === 'cache',
  );
  assert.equal(degrade.params.mode, 'fallback');
  assert.equal(degrade.params.fallbackTo, 'db');
});

test('isolation switches shed load only from affected services', () => {
  const scenario = sharedCacheScenario();
  scenario.isolationSwitches.push({ id: 'irrelevant', shedsRps: { other: 50 } });
  const plan = planContainment(scenario);
  const switches = plan.actions.filter((a) => a.type === 'degrade' && a.switchId);
  assert.deepEqual(switches.map((s) => s.switchId), ['shed-worker']);
});

test('recovery ramps gradually, deepest dependency first, with rollback conditions', () => {
  const scenario = sharedCacheScenario();
  scenario.nodes.cache.dependsOn = ['db'];
  scenario.nodes.db.errorRate = 0.5;
  const plan = planContainment(scenario);

  assert.deepEqual(plan.recovery.order, ['db', 'cache']);
  assert.deepEqual(plan.recovery.stages, [5, 25, 50, 100]);
  assert.ok(plan.recovery.stages[0] <= 5, 'first stage must be a small canary');
  assert.ok(plan.recovery.rollbackConditions.length >= 3);
  assert.ok(plan.recovery.rollbackConditions.some((c) => c.includes('re-open')));
});

test('plan output is deterministic and contains no real-control side effects', () => {
  const a = planContainment(sharedCacheScenario());
  const b = planContainment(sharedCacheScenario());
  assert.deepEqual(a, b);
  assert.ok(!JSON.stringify(a).includes('executed'));
});
