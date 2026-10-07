#!/usr/bin/env node
// 本地端到端脚本：对一个正在运行的 aster-api 走一遍 check → 审批 → 读取最终结论（ADR 0040 §6）。
//
// 前提：aster-api 已启动，租户已部署示例策略（见 README「本地端到端」），并持有 API key。
// aster-api 没有公开的 API key 创建与策略部署端点，二者都经 aster-cloud 或直写数据库完成，脚本只负责流程。
// 通过 dist/ 里的公开 SDK 调用，运行前需先 `pnpm build`。
//
// 环境变量：
//   ASTER_GUARD_BASE_URL          aster-api 根地址，默认 http://localhost:8080
//   ASTER_GUARD_API_KEY           请求方 API key，必填
//   ASTER_GUARD_POLICY            <module>/<function>，默认 guard.customer/decide
//   ASTER_GUARD_APPROVER_API_KEY  审批方 API key，可选；四眼规则要求审批方与请求方是不同的 key 与用户
//   ASTER_GUARD_APPROVER_ROLE     审批方业务角色，默认 Data Protection Officer（作为 businessRole 发送）
//
// 退出码：0 全部通过（审批步骤因缺第二把 key 被 SKIP 也算通过）；1 断言失败；2 参数错误。
import { GuardClient } from '../dist/index.js';

const USAGE = `用法：ASTER_GUARD_API_KEY=ak_… node scripts/e2e-local.mjs

环境变量：
  ASTER_GUARD_BASE_URL          aster-api 根地址（默认 http://localhost:8080）
  ASTER_GUARD_API_KEY           请求方 API key（必填）
  ASTER_GUARD_POLICY            <module>/<function>（默认 guard.customer/decide）
  ASTER_GUARD_APPROVER_API_KEY  审批方 API key（可选；缺省时 SKIP 审批步骤）
  ASTER_GUARD_APPROVER_ROLE     审批方业务角色（默认 Data Protection Officer）
`;

const DEFAULT_BASE_URL = 'http://localhost:8080';
const DEFAULT_POLICY = 'guard.customer/decide';
const DEFAULT_APPROVER_ROLE = 'Data Protection Officer';

/** 断言失败：携带需要完整打印的对象（决策或审批结果）。 */
class StepFailure extends Error {
  constructor(message, payload) {
    super(message);
    this.payload = payload;
  }
}

/** 读取环境变量并去掉首尾空白；空串或纯空白视为未设置（必填项因此走用法提示与退出码 2）。 */
function env(name, fallback) {
  return process.env[name]?.trim() || fallback;
}

/** 解析配置；参数错误时返回 undefined 并已把原因写到 stderr。 */
function readConfig() {
  const apiKey = env('ASTER_GUARD_API_KEY');
  if (!apiKey) {
    process.stderr.write(`缺少必填环境变量 ASTER_GUARD_API_KEY\n\n${USAGE}`);
    return undefined;
  }
  const policy = env('ASTER_GUARD_POLICY', DEFAULT_POLICY);
  const slash = policy.lastIndexOf('/');
  if (slash <= 0 || slash === policy.length - 1) {
    process.stderr.write(`ASTER_GUARD_POLICY 须为 <module>/<function>，实际为 "${policy}"\n\n${USAGE}`);
    return undefined;
  }
  return {
    baseUrl: env('ASTER_GUARD_BASE_URL', DEFAULT_BASE_URL),
    apiKey,
    policyModule: policy.slice(0, slash),
    policyFunction: policy.slice(slash + 1),
    approverApiKey: env('ASTER_GUARD_APPROVER_API_KEY'),
    approverRole: env('ASTER_GUARD_APPROVER_ROLE', DEFAULT_APPROVER_ROLE),
  };
}

/** 断言成立则打印一行 ✓，否则抛 StepFailure（附带完整对象，由入口统一打印）。 */
function expectStep(passed, label, payload) {
  if (!passed) throw new StepFailure(label, payload);
  console.log(`✓ ${label}`);
}

/** 执行全部步骤；返回 false 表示审批步骤因缺第二把 key 被跳过。 */
async function run(config) {
  const { baseUrl, apiKey, policyModule, policyFunction } = config;
  // 每次运行用全新的 principal.id：本次产生的决策与审批在审计记录里可与历史运行区分，互不串扰。
  const requester = new GuardClient({
    baseUrl,
    apiKey,
    policyModule,
    policyFunction,
    principal: { id: `e2e-${Date.now()}`, type: 'agent' },
  });
  const resource = { type: 'customer', id: 'C-E2E-1' };

  const read = await requester.check({ action: { name: 'read_customer_record' }, resource });
  expectStep(read.effectiveOutcome === 'ALLOW', '[1] read_customer_record → ALLOW', read);

  const del = await requester.check({ action: { name: 'delete_customer_record' }, resource });
  const approvalId = del.approval?.id;
  expectStep(
    del.effectiveOutcome === 'PENDING' && typeof approvalId === 'string' && approvalId !== '',
    `[2] delete_customer_record → PENDING（实际 ${del.effectiveOutcome}，approvalId ${approvalId ?? '缺失'}）`,
    del,
  );

  if (!config.approverApiKey) {
    console.log('SKIP: 审批步骤需要第二把 API key (ASTER_GUARD_APPROVER_API_KEY)');
    return false;
  }

  const approver = new GuardClient({
    baseUrl,
    apiKey: config.approverApiKey,
    policyModule,
    policyFunction,
  });
  const approved = await approver.approve(approvalId, { comment: 'e2e', businessRole: config.approverRole });
  expectStep(approved.ok === true, `[3] 审批方以 "${config.approverRole}" 批准 ${approvalId}`, approved);

  const final = await requester.get(del.decisionId);
  expectStep(final.effectiveOutcome === 'ALLOW', '[4] 请求方读取决策 → ALLOW', final);
  return true;
}

async function main() {
  const config = readConfig();
  if (!config) return 2;
  let approvalCovered;
  try {
    approvalCovered = await run(config);
  } catch (e) {
    if (!(e instanceof StepFailure)) throw e;
    console.log(`✗ ${e.message}`);
    console.log(JSON.stringify(e.payload, null, 2));
    return 1;
  }
  console.log(approvalCovered ? '端到端检查通过' : '端到端检查通过（审批步骤已跳过）');
  return 0;
}

process.exitCode = await main();
