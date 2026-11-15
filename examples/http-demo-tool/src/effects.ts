// 演示工具的「副作用」：每次工具执行追加一条记录。探针据此判断无票据调用是否真的执行了
// （aster-api ADR 0054 §12 D6–D8：只看 HTTP 状态不够，反向记录必须证明副作用发生）。

/** 只保留最近这么多条明细；计数不受影响。 */
const KEEP = 20;
/** marker 截断长度。 */
const MARKER_MAX = 64;

export interface EffectEntry {
  tool: string;
  marker: string;
  /** 无票据执行（TICKET_CHECK=off）时为 null。 */
  decisionId: string | null;
  attemptId: string | null;
  at: string;
}

export interface EffectSnapshot {
  /** 进程启动以来的执行次数。 */
  count: number;
  /** 其中无票据执行的次数。 */
  unticketed: number;
  /** 最近的明细（至多 20 条）；给出 marker 时只含该标记的条目。 */
  last: EffectEntry[];
}

export class EffectLog {
  private count = 0;
  private unticketed = 0;
  private readonly entries: EffectEntry[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  record(tool: string, marker: string, ticket: { decisionId: string; attemptId: string } | null): EffectEntry {
    const entry: EffectEntry = {
      tool,
      marker: marker.slice(0, MARKER_MAX),
      decisionId: ticket?.decisionId ?? null,
      attemptId: ticket?.attemptId ?? null,
      at: new Date(this.now()).toISOString(),
    };
    this.count++;
    if (ticket === null) this.unticketed++;
    this.entries.push(entry);
    if (this.entries.length > KEEP) this.entries.shift();
    return entry;
  }

  snapshot(marker?: string): EffectSnapshot {
    const wanted = marker === undefined ? undefined : marker.slice(0, MARKER_MAX);
    return {
      count: this.count,
      unticketed: this.unticketed,
      last: this.entries.filter((e) => wanted === undefined || e.marker === wanted).map((e) => ({ ...e })),
    };
  }
}
