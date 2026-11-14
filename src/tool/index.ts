// 子路径入口 @aster-cloud/aster-guard/tool：被守卫的上游工具在 auth 隔离模式下核对 consume 票据（ADR 0054 §3.3，R66）。
export {
  CONSUME_TICKET_META_KEY,
  DEFAULT_TICKET_TTL_MS,
  MemoryAttemptLedger,
  verifyConsumeTicket,
} from './consume-ticket.js';
export type { AttemptLedger, ConsumeTicket, TicketRejection, VerifyConsumeTicketInput } from './consume-ticket.js';
export type { ActionMapping } from '../mcp/action-mapping.js';
