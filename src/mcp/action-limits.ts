// 服务端对 Action 的限制（aster-api GuardActionMapper）。代理构造 Action 与 CLI 校验配置时共用，
// 让违反限制的输入在本地就被规整或在启动时拒绝，而不是在每次调用时变成 DENY http_400。

/** 文本字段（principal.id / type / roles 各项、resource.id、agent.model）的最大长度，按 UTF-16 码元计，与服务端一致。 */
export const MAX_TEXT_LENGTH = 255;

/** principal.roles 的最多项数。 */
export const MAX_ROLES = 16;

/** Unicode Cc 类：U+0000–U+001F 与 U+007F–U+009F，与服务端 Character.isISOControl 的范围相同。 */
const CONTROL_CHAR = /\p{Cc}/u;

export function hasControlChar(text: string): boolean {
  return CONTROL_CHAR.test(text);
}

/** 能否原样作为服务端的文本字段：≤ 255 字符且不含控制字符。 */
export function isActionText(text: string): boolean {
  return text.length <= MAX_TEXT_LENGTH && !hasControlChar(text);
}
