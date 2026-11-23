import {
  buildGraph,
  directCallers,
  transitiveDependents,
  amplifiedLoad,
  loadOn,
  depthOf,
} from './graph.js';
import { DEFAULT_RECOVERY_STAGES } from './recovery.js';

const SAFETY_MARGIN = 0.9;

export function planContainment(scenario) {
  const {
    name = 'unnamed-scenario',
    nodes,
    slo,
    isolationSwitches = [],
    recoveryProbes = [],
  } = scenario;
  if (!nodes || typeof nodes !== 'object') {
    throw new Error('scenario.nodes is required');
  }
  if (!slo || typeof slo.maxErrorRate !== 'number') {
    throw new Error('scenario.slo.maxErrorRate is required');
  }
  const graph = buildGraph(nodes);

  const faulted = Object.keys(nodes)
    .filter(
      (n) =>
        nodes[n].kind === 'dependency' &&
        (nodes[n].errorRate ?? 0) > slo.maxErrorRate,
    )
    .sort((a, b) => depthOf(graph, a) - depthOf(graph, b));

  const affected = new Set();
  for (const f of faulted) {
    for (const s of transitiveDependents(graph, f)) affected.add(s);
  }

  const effectiveRps = new Map(
    Object.entries(nodes).map(([n, def]) => [n, def.currentRps ?? 0]),
  );

  const actions = [];
  let order = 0;
  const push = (action) => {
    order += 1;
    actions.push({ order, ...action });
  };

  for (const sw of isolationSwitches) {
    const sheds = sw.shedsRps ?? {};
    const targets = Object.keys(sheds).filter((s) => affected.has(s));
    if (targets.length === 0) continue;
    for (const svc of targets) {
      effectiveRps.set(svc, Math.max(0, effectiveRps.get(svc) - sheds[svc]));
    }
    push({
      type: 'degrade',
      target: targets,
      switchId: sw.id,
      params: { shedsRps: sheds },
      reason: `enable isolation switch "${sw.id}" to shed non-critical load`,
      rollback: `disable switch "${sw.id}" after all recovery stages complete and error rate stays below SLO for 2 consecutive windows`,
    });
  }

  for (const f of faulted) {
    for (const caller of directCallers(graph, f).sort()) {
      push({
        type: 'circuit-breaker',
        target: caller,
        dependency: f,
        params: { state: 'open', halfOpenProbeRps: 1 },
        reason: `dependency "${f}" error rate ${nodes[f].errorRate} exceeds SLO ${slo.maxErrorRate}`,
        rollback:
          'never close directly; close only through staged recovery; re-open immediately if probe success falls below threshold',
      });
    }
  }

  for (const f of faulted) {
    for (const caller of directCallers(graph, f).sort()) {
      const fallback = nodes[caller].fallbacks?.[f];
      if (!fallback) continue;
      const shifted = amplifiedLoad(graph, effectiveRps, caller, f);
      const projected = loadOn(graph, effectiveRps, fallback) + shifted;
      const ceiling = (nodes[fallback].capacityRps ?? Infinity) * SAFETY_MARGIN;
      if (projected > ceiling) {
        push({
          type: 'degrade',
          target: caller,
          dependency: f,
          params: { mode: 'fail-fast', serve: 'stale-or-default' },
          reason: `fallback to "${fallback}" would project ${Math.round(projected)} rps against safe capacity ${Math.round(ceiling)} rps; fail fast instead of shifting load`,
          rollback: `re-enable fallback only when "${f}" completes staged recovery`,
        });
        const headroom = Math.max(
          0,
          ceiling - loadOn(graph, effectiveRps, fallback),
        );
        push({
          type: 'rate-limit',
          target: caller,
          dependency: fallback,
          params: { maxRps: Math.round(headroom) },
          reason: `cap "${caller}" so residual traffic cannot saturate remaining dependency "${fallback}"`,
          rollback: `raise limit gradually after "${f}" recovery completes and "${fallback}" utilization stays below ${SAFETY_MARGIN * 100}%`,
        });
      } else {
        push({
          type: 'degrade',
          target: caller,
          dependency: f,
          params: { mode: 'fallback', fallbackTo: fallback },
          reason: `fallback to "${fallback}" fits within safe capacity (${Math.round(projected)} <= ${Math.round(ceiling)} rps)`,
          rollback: `switch back to "${f}" after staged recovery completes`,
        });
      }
    }
  }

  const healthyDeps = Object.keys(nodes).filter(
    (n) => nodes[n].kind === 'dependency' && !faulted.includes(n),
  );
  for (const dep of healthyDeps.sort()) {
    const capacity = nodes[dep].capacityRps;
    if (capacity == null) continue;
    const total = loadOn(graph, effectiveRps, dep);
    const ceiling = capacity * SAFETY_MARGIN;
    if (total <= ceiling) continue;
    const ratio = ceiling / total;
    const contributors = directCallers(graph, dep)
      .map((c) => ({ caller: c, load: amplifiedLoad(graph, effectiveRps, c, dep) }))
      .filter((c) => c.load > 0)
      .sort((a, b) => b.load - a.load);
    for (const { caller, load } of contributors) {
      push({
        type: 'rate-limit',
        target: caller,
        dependency: dep,
        params: { maxRps: Math.round(load * ratio) },
        reason: `retry-amplified load on "${dep}" is ${Math.round(total)} rps, above safe capacity ${Math.round(ceiling)} rps; scale caller to ${(ratio * 100).toFixed(1)}%`,
        rollback: `raise limit one step at a time once "${dep}" error rate stays below SLO and utilization below ${SAFETY_MARGIN * 100}% for 2 consecutive windows`,
      });
    }
  }

  const recovery = {
    order: faulted,
    stages: DEFAULT_RECOVERY_STAGES,
    gates: faulted.map((f) => ({
      dependency: f,
      probes: recoveryProbes
        .filter((p) => p.target === f)
        .map((p) => ({
          id: p.id ?? `${f}-probe`,
          successThreshold: p.successThreshold ?? 0.95,
          windowSeconds: p.windowSeconds ?? 30,
        })),
      advanceWhen: `all probes pass and downstream utilization below ${SAFETY_MARGIN * 100}% for a full window`,
    })),
    rollbackConditions: [
      `probe success below threshold: drop one stage (never below ${DEFAULT_RECOVERY_STAGES[0]}%)`,
      `error rate above SLO ${slo.maxErrorRate}: re-open circuit breaker and return to stage 1`,
      'flapping beyond maxFlaps: halt ramp, keep breaker open, escalate to human',
    ],
  };

  return {
    scenario: name,
    impactScope: {
      faultedDependencies: faulted,
      affectedServices: [...affected].sort(),
      criticalServicesAffected: [...affected]
        .filter((s) => nodes[s].critical)
        .sort(),
      amplifiedLoadRps: Object.fromEntries(
        Object.keys(nodes)
          .filter((n) => nodes[n].kind === 'dependency')
          .sort()
          .map((d) => [d, Math.round(loadOn(graph, effectiveRps, d))]),
      ),
    },
    actions,
    recovery,
  };
}
