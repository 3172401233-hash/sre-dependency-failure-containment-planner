export function buildGraph(nodes) {
  const dependencies = new Map();
  const callers = new Map();
  for (const name of Object.keys(nodes)) {
    dependencies.set(name, []);
    callers.set(name, []);
  }
  for (const [name, def] of Object.entries(nodes)) {
    for (const dep of def.dependsOn ?? []) {
      if (!nodes[dep]) {
        throw new Error(`node "${name}" depends on unknown node "${dep}"`);
      }
      dependencies.get(name).push(dep);
      callers.get(dep).push(name);
    }
  }
  assertAcyclic(dependencies);
  return { nodes, dependencies, callers };
}

function assertAcyclic(dependencies) {
  const state = new Map();
  const visit = (name, stack) => {
    const s = state.get(name);
    if (s === 'done') return;
    if (s === 'visiting') {
      throw new Error(`dependency cycle detected: ${[...stack, name].join(' -> ')}`);
    }
    state.set(name, 'visiting');
    for (const dep of dependencies.get(name) ?? []) visit(dep, [...stack, name]);
    state.set(name, 'done');
  };
  for (const name of dependencies.keys()) visit(name, []);
}

export function directCallers(graph, dep) {
  return [...graph.callers.get(dep)];
}

export function transitiveDependents(graph, target) {
  const seen = new Set();
  const queue = [...graph.callers.get(target)];
  while (queue.length > 0) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    queue.push(...graph.callers.get(name));
  }
  return seen;
}

export function retryMultiplier(def) {
  const attempts = def?.retries?.maxAttempts ?? 1;
  return Math.max(1, attempts);
}

export function pathMultipliers(graph, from, to) {
  const results = [];
  const walk = (name, acc, visited) => {
    if (name === to) {
      results.push(acc);
      return;
    }
    const nextAcc = acc * retryMultiplier(graph.nodes[name]);
    for (const dep of graph.dependencies.get(name) ?? []) {
      if (visited.has(dep)) continue;
      visited.add(dep);
      walk(dep, nextAcc, visited);
      visited.delete(dep);
    }
  };
  walk(from, 1, new Set([from]));
  return results;
}

export function amplifiedLoad(graph, rpsOf, from, to) {
  const base = typeof rpsOf === 'function' ? rpsOf(from) : (rpsOf.get(from) ?? 0);
  const multiplier = pathMultipliers(graph, from, to).reduce((a, b) => a + b, 0);
  return base * multiplier;
}

export function loadOn(graph, rpsOf, dep) {
  let total = 0;
  for (const name of Object.keys(graph.nodes)) {
    if (name === dep) continue;
    total += amplifiedLoad(graph, rpsOf, name, dep);
  }
  return total;
}

export function depthOf(graph, name) {
  const deps = graph.dependencies.get(name) ?? [];
  if (deps.length === 0) return 0;
  return 1 + Math.max(...deps.map((d) => depthOf(graph, d)));
}
