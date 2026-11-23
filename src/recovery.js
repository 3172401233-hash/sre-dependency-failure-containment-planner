export const DEFAULT_RECOVERY_STAGES = [5, 25, 50, 100];

export class RecoveryController {
  constructor({
    stages = DEFAULT_RECOVERY_STAGES,
    maxFlaps = 3,
    minProbeSuccess = 0.95,
    maxErrorRate = 0.01,
  } = {}) {
    if (!Array.isArray(stages) || stages.length === 0) {
      throw new Error('stages must be a non-empty array');
    }
    for (let i = 1; i < stages.length; i += 1) {
      if (stages[i] <= stages[i - 1]) {
        throw new Error('stages must be strictly increasing');
      }
    }
    if (stages[0] <= 0 || stages[stages.length - 1] !== 100) {
      throw new Error('stages must start above 0 and end at 100');
    }
    this.stages = [...stages];
    this.maxFlaps = maxFlaps;
    this.minProbeSuccess = minProbeSuccess;
    this.maxErrorRate = maxErrorRate;
    this.index = 0;
    this.flaps = 0;
    this.halted = false;
    this.completed = false;
  }

  get currentStage() {
    return this.stages[this.index];
  }

  evaluate({ probeSuccessRate, errorRate }) {
    if (this.halted) {
      return { action: 'halted', stage: this.currentStage, flaps: this.flaps };
    }
    if (this.completed) {
      return { action: 'complete', stage: 100, flaps: this.flaps };
    }
    const healthy =
      probeSuccessRate >= this.minProbeSuccess && errorRate <= this.maxErrorRate;
    if (healthy) {
      if (this.index === this.stages.length - 1) {
        this.completed = true;
        return { action: 'complete', stage: 100, flaps: this.flaps };
      }
      this.index += 1;
      return { action: 'advance', stage: this.currentStage, flaps: this.flaps };
    }
    this.flaps += 1;
    if (this.flaps > this.maxFlaps) {
      this.halted = true;
      return {
        action: 'halt',
        stage: this.currentStage,
        flaps: this.flaps,
        reason: 'flap-limit-exceeded',
      };
    }
    if (this.index > 0) this.index -= 1;
    return { action: 'rollback', stage: this.currentStage, flaps: this.flaps };
  }
}
