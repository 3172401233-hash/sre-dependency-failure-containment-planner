# sre-dependency-failure-containment-planner

规划依赖故障的隔离、限流和恢复边界。

> **重要：本工具只做规划，不执行任何真实控制动作。**
> 它读取场景描述，输出一份结构化的处置计划（JSON），
> 不会调用任何限流、熔断、降级或恢复接口，也不会修改任何线上状态。
> 计划由人审核后，由其他系统或人工执行。

## 运行环境

- Node.js >= 24（开发验证版本 24.16.0），无第三方依赖。

## 使用

```bash
node src/cli.js examples/incident.json   # 输出处置计划 JSON
npm test                                 # node --test
```

## 输入（场景 JSON）

- `nodes`：依赖图。服务节点含 `capacityRps`、`currentRps`、`critical`、`dependsOn`、`retries.maxAttempts`、`fallbacks`；依赖节点含 `capacityRps`、`errorRate`、`shared`。
- `slo`：如 `maxErrorRate`，用于判定故障依赖与恢复门禁。
- `isolationSwitches`：隔离开关，`shedsRps` 描述可削减的非关键流量。
- `recoveryProbes`：恢复探测，`successThreshold` / `windowSeconds` 作为放量门禁。

## 规划逻辑

1. **影响范围**：从故障依赖沿调用链向上找出全部受影响服务；按多路径重试放大系数（路径上各服务重试次数之积、多路径求和）估算每个依赖承受的放大流量。
2. **动作序列**（按序输出，均附回滚条件）：
   - `degrade`：启用隔离开关，先削非关键流量；
   - `circuit-breaker`：对故障依赖的所有直接调用方熔断；
   - `degrade`（fail-fast / fallback）：上游降级前校验剩余依赖容量，回退会压垮剩余依赖时改为快速失败并叠加限流；
   - `rate-limit`：任一健康依赖的重试放大流量超过安全容量（90%）时，按贡献比例限制调用方。
3. **恢复顺序**：被依赖的底层依赖先恢复；按 5% → 25% → 50% → 100% 分阶段放量，每阶段由探测门禁把关，绝不一次放全量。
4. **回滚条件**：探测成功率低于阈值降一档；错误率超 SLO 重新熔断回到第一阶段；抖动超过 `maxFlaps` 停止放量并升级人工。

## 输出

- `impactScope`：故障依赖、受影响服务（含关键服务）、各依赖的放大流量。
- `actions`：有序动作列表，每条含 `type` / `target` / `params` / `reason` / `rollback`。
- `recovery`：恢复顺序、放量阶段、每阶段门禁与回滚条件。

## 测试

`node --test` 覆盖：共享依赖故障的爆炸半径与多点熔断、多路径重试放大、
降级压垮剩余依赖的防护、恢复抖动回滚与停梯、分阶段放量不跳档。
