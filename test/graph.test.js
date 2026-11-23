import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildGraph,
  transitiveDependents,
  amplifiedLoad,
  loadOn,
  pathMultipliers,
} from '../src/graph.js';

const multiPathNodes = {
  web: {
    kind: 'service',
    currentRps: 100,
    dependsOn: ['svcA', 'svcB'],
    retries: { maxAttempts: 2 },
  },
  svcA: {
    kind: 'service',
    currentRps: 0,
    dependsOn: ['db'],
    retries: { maxAttempts: 3 },
  },
  svcB: {
    kind: 'service',
    currentRps: 0,
    dependsOn: ['db'],
    retries: { maxAttempts: 1 },
  },
  db: { kind: 'dependency', capacityRps: 10000 },
};

test('multi-path retries amplify load additively across paths', () => {
  const graph = buildGraph(multiPathNodes);
  assert.deepEqual(pathMultipliers(graph, 'web', 'db').sort(), [2, 6]);
  const rps = new Map([['web', 100]]);
  assert.equal(amplifiedLoad(graph, rps, 'web', 'db'), 800);
  assert.equal(loadOn(graph, rps, 'db'), 800);
});

test('transitive dependents traverse shared dependencies upward', () => {
  const graph = buildGraph(multiPathNodes);
  assert.deepEqual([...transitiveDependents(graph, 'db')].sort(), [
    'svcA',
    'svcB',
    'web',
  ]);
});

test('dependency cycles are rejected', () => {
  assert.throws(
    () =>
      buildGraph({
        a: { kind: 'service', dependsOn: ['b'] },
        b: { kind: 'service', dependsOn: ['a'] },
      }),
    /cycle/,
  );
});
