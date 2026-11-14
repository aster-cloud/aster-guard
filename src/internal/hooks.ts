// 仅测试用的内部钩子：以 Symbol 为键挂在 run 的选项上（Object.keys 不可见、不随包入口导出、CLI 不暴露）。
// 绕过套件 #3 用它在 consume 之前篡改参数，证明 consume 时重算的 actionHash 会让服务端 409 action_mismatch。

/** 在 run 的 consume 之前调用（同步）。 */
export const BEFORE_CONSUME = Symbol('aster-guard.beforeConsume');

export interface InternalRunHooks {
  [BEFORE_CONSUME]?: () => void;
}
