import type { DebuggerClient, VariableNode } from "./hubs/debugger-hub";
import { redactAuthorization } from "./redaction";
import type { DebuggerEvent, StackFrameInfo } from "./types";

export type RecordWriteOperation = "insert" | "modify" | "modifyAll" | "rename" | "delete" | "deleteAll";
export type RecordWriteSource = "deployed" | "localAsserted";
export type RecordWriteUnresolvedReason =
  | "sourceUnavailable"
  | "statementSpanUnavailable"
  | "writeStatementUnrecognized"
  | "multipleWriteCandidates"
  | "receiverUnsupported"
  | "receiverUnavailable"
  | "receiverTypeUnresolved"
  | "inspectionFailed"
  | "unexpectedBreak";

export interface RecordWriteTarget {
  tableId: number;
  tableName: string | null;
}

export interface RecordWriteSummary {
  observedWrites: number;
  matchedWrites: number;
  uniqueWriters: number;
  unrelatedWrites: number;
  unresolvedWrites: number;
}

export interface RecordWriteWriterGroup {
  operation: RecordWriteOperation;
  receiver: string;
  count: number;
  firstSequence: number;
  lastSequence: number;
  source: RecordWriteSource;
  stack: StackFrameInfo[];
}

export interface RecordWriteUnresolvedGroup {
  reason: RecordWriteUnresolvedReason;
  operation: RecordWriteOperation | null;
  receiver: string | null;
  count: number;
  firstSequence: number;
  lastSequence: number;
  stack: StackFrameInfo[];
}

export interface RecordWriteStatus {
  phase: "arming" | "collecting" | "stopped" | "failed";
  target: RecordWriteTarget;
  sessionId: number | null;
  summary: RecordWriteSummary;
  truncated: boolean;
  warning: string | null;
}

export interface RecordWriteReport {
  target: RecordWriteTarget;
  outcome: "completed" | "truncated" | "failed";
  stopReason: "finished" | "sessionDetached" | "maxObservedWrites" | "fatal";
  complete: boolean;
  truncated: boolean;
  summary: RecordWriteSummary;
  writers: RecordWriteWriterGroup[];
  unresolved: RecordWriteUnresolvedGroup[];
  warnings: string[];
}

export interface RecordWriteStatement {
  operation: RecordWriteOperation;
  receiver: string;
}

export type RecordWriteStatementResult =
  | { statement: RecordWriteStatement; reason: null }
  | {
      statement: null;
      reason: "writeStatementUnrecognized" | "multipleWriteCandidates" | "receiverUnsupported";
    };

export interface RuntimeTableType {
  tableId: number;
  tableName: string;
}

interface Token {
  kind:
    | "identifier"
    | "dot"
    | "leftParen"
    | "rightParen"
    | "leftBracket"
    | "rightBracket"
    | "semicolon"
    | "other";
  text: string;
  start: number;
  end: number;
}

interface SourceRecord {
  content: string;
  source: "deployed" | "local";
  trusted: boolean;
}

export interface RecordWriteCollectorOptions {
  tableId: number;
  changesDeployed: boolean;
  maxObservedWrites: number;
  client: Pick<DebuggerClient, "getSourceContent" | "evalWatch" | "step" | "releaseForShutdown" | "stop">;
  localSource: (objectType: number, objectId: number) => Promise<string | null>;
  localFile: (objectType: number, objectId: number) => string | undefined;
}

const OPERATION_BY_NAME: Record<string, RecordWriteOperation> = {
  // WIRE: DebugOptions.BreakOnRecordWrite stops on the AL database write methods
  // Insert, Modify, ModifyAll, Rename, Delete, and DeleteAll (Microsoft AL debugger
  // documentation; exercised by the live checklist in scripts/e2e.md).
  insert: "insert",
  modify: "modify",
  modifyall: "modifyAll",
  rename: "rename",
  delete: "delete",
  deleteall: "deleteAll",
};

function lexStatement(source: string): Token[] {
  const tokens: Token[] = [];
  for (let i = 0; i < source.length;) {
    const tokenStart = i;
    const ch = source[i]!;
    const next = source[i + 1];
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (ch === "/" && next === "/") {
      i += 2;
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < source.length && !(source[i] === "*" && source[i + 1] === "/")) i++;
      i = Math.min(source.length, i + 2);
      continue;
    }
    if (ch === "'") {
      i++;
      while (i < source.length) {
        if (source[i] === "'" && source[i + 1] === "'") {
          i += 2;
        } else if (source[i] === "'") {
          i++;
          break;
        } else {
          i++;
        }
      }
      continue;
    }
    if (ch === '"') {
      let text = '"';
      i++;
      while (i < source.length) {
        text += source[i]!;
        if (source[i] === '"' && source[i + 1] === '"') {
          text += source[i + 1]!;
          i += 2;
        } else if (source[i] === '"') {
          i++;
          break;
        } else {
          i++;
        }
      }
      tokens.push({ kind: "identifier", text, start: tokenStart, end: i });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      const start = i++;
      while (i < source.length && /[A-Za-z0-9_]/.test(source[i]!)) i++;
      tokens.push({ kind: "identifier", text: source.slice(start, i), start, end: i });
      continue;
    }
    const kind = ch === "."
      ? "dot"
      : ch === "("
        ? "leftParen"
        : ch === ")"
          ? "rightParen"
          : ch === "["
            ? "leftBracket"
            : ch === "]"
              ? "rightBracket"
              : ch === ";"
                ? "semicolon"
                : "other";
    tokens.push({ kind, text: ch, start: tokenStart, end: tokenStart + 1 });
    i++;
  }
  return tokens;
}

function lineOffsets(source: string): number[] {
  const offsets = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

interface LocatedStatementSource {
  content: string;
  start: number;
}

function locateStatementSource(
  source: string,
  span: NonNullable<StackFrameInfo["statementSpan"]>,
): LocatedStatementSource | null {
  const offsets = lineOffsets(source);
  const fromLine = span.from.line - 1;
  const toLine = span.to.line - 1;
  if (fromLine < 0 || toLine < fromLine || fromLine >= offsets.length || toLine >= offsets.length) return null;
  const from = offsets[fromLine]! + Math.max(0, span.from.column - 1);
  const lineEnd = toLine + 1 < offsets.length ? offsets[toLine + 1]! : source.length;
  const to = Math.min(lineEnd, offsets[toLine]! + Math.max(span.to.column, span.from.line === span.to.line ? span.from.column : 1));
  if (from < 0 || from >= source.length || to <= from) return null;
  return { content: source.slice(from, to), start: from };
}

export function sourceAtStatementSpan(source: string, span: NonNullable<StackFrameInfo["statementSpan"]>): string | null {
  return locateStatementSource(source, span)?.content ?? null;
}

const NO_ARGUMENT_OPERATION = new Set<RecordWriteOperation>(["insert", "modify", "delete", "deleteAll"]);
const NO_ARGUMENT_FOLLOWER = new Set(["then", "do", "else", "until", "and", "or"]);

interface InternalRecordWriteStatement {
  statement: RecordWriteStatement;
  implicitReceiver: boolean;
  operationOffset: number;
}

type InternalStatementResult =
  | { match: InternalRecordWriteStatement; reason: null }
  | {
      match: null;
      reason: "writeStatementUnrecognized" | "multipleWriteCandidates" | "receiverUnsupported";
    };

function isOperationInvocation(tokens: Token[], index: number, operation: RecordWriteOperation): boolean {
  const next = tokens[index + 1];
  if (next?.kind === "leftParen") return true;
  if (!NO_ARGUMENT_OPERATION.has(operation)) return false;
  if (!next || next.kind === "semicolon" || next.kind === "rightParen" || next.kind === "rightBracket") return true;
  return next.kind === "identifier" && NO_ARGUMENT_FOLLOWER.has(next.text.toLowerCase());
}

function inspectStatement(source: string): InternalStatementResult {
  const tokens = lexStatement(source);
  const matches: InternalRecordWriteStatement[] = [];
  let unsupportedReceiver = false;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const operation = token.kind === "identifier" ? OPERATION_BY_NAME[token.text.toLowerCase()] : undefined;
    if (!operation || !isOperationInvocation(tokens, i, operation)) continue;
    if (tokens[i - 1]?.kind === "dot") {
      const receiver = tokens[i - 2];
      if (!receiver || receiver.kind !== "identifier") {
        unsupportedReceiver = true;
        continue;
      }
      const beforeReceiver = tokens[i - 3];
      if (
        beforeReceiver?.kind === "dot"
        || beforeReceiver?.kind === "rightParen"
        || beforeReceiver?.kind === "rightBracket"
      ) {
        unsupportedReceiver = true;
        continue;
      }
      matches.push({
        statement: { operation, receiver: receiver.text },
        implicitReceiver: false,
        operationOffset: token.start,
      });
    } else {
      matches.push({
        statement: { operation, receiver: "Rec" },
        implicitReceiver: true,
        operationOffset: token.start,
      });
    }
  }
  if (unsupportedReceiver) return { match: null, reason: "receiverUnsupported" };
  if (matches.length > 1) return { match: null, reason: "multipleWriteCandidates" };
  if (matches.length === 0) return { match: null, reason: "writeStatementUnrecognized" };
  return { match: matches[0]!, reason: null };
}

function tokenLower(token: Token | undefined): string {
  return token?.kind === "identifier" ? token.text.toLowerCase() : "";
}

function afterOptionalSemicolon(tokens: Token[], index: number): number {
  return tokens[index]?.kind === "semicolon" ? index + 1 : index;
}

function matchingEnd(tokens: Token[], start: number): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    const lower = tokenLower(tokens[i]);
    if (lower === "begin" || lower === "case") {
      depth++;
    } else if (lower === "end") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }
  return tokens.length;
}

function matchingUntil(tokens: Token[], start: number): number {
  let depth = 0;
  for (let i = start; i < tokens.length; i++) {
    const lower = tokenLower(tokens[i]);
    if (lower === "repeat") {
      depth++;
    } else if (lower === "until") {
      depth--;
      if (depth === 0) {
        for (let j = i + 1; j < tokens.length; j++) {
          if (tokens[j]?.kind === "semicolon") return j + 1;
        }
        return tokens.length;
      }
    }
  }
  return tokens.length;
}

function statementEnd(tokens: Token[], start: number): number {
  const first = tokenLower(tokens[start]);
  if (first === "begin" || first === "case") {
    const end = matchingEnd(tokens, start);
    if (tokenLower(tokens[end]) === "else") return statementEnd(tokens, end + 1);
    return afterOptionalSemicolon(tokens, end);
  }
  if (first === "repeat") return matchingUntil(tokens, start);

  let parentheses = 0;
  let brackets = 0;
  for (let i = start; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.kind === "leftParen") parentheses++;
    if (token.kind === "rightParen") parentheses = Math.max(0, parentheses - 1);
    if (token.kind === "leftBracket") brackets++;
    if (token.kind === "rightBracket") brackets = Math.max(0, brackets - 1);
    if (parentheses !== 0 || brackets !== 0) continue;

    const lower = tokenLower(token);
    if (i > start && (lower === "begin" || lower === "case")) {
      const end = matchingEnd(tokens, i);
      if (tokenLower(tokens[end]) === "else") return statementEnd(tokens, end + 1);
      return afterOptionalSemicolon(tokens, end);
    }
    if (i > start && lower === "repeat") return matchingUntil(tokens, i);
    if (token.kind === "semicolon") return i + 1;
  }
  return tokens.length;
}

type ExplicitWithContext =
  | { kind: "none" }
  | { kind: "receiver"; receiver: string }
  | { kind: "ambiguous" };

function explicitWithContext(source: string, operationOffset: number): ExplicitWithContext {
  const tokens = lexStatement(source);
  const operationIndex = tokens.findIndex((token) =>
    token.start <= operationOffset && operationOffset < token.end
  );
  if (operationIndex < 0) return { kind: "none" };

  let context: ExplicitWithContext = { kind: "none" };
  let nearestDo = -1;
  for (let i = 0; i < operationIndex; i++) {
    if (tokenLower(tokens[i]) !== "with") continue;
    let doIndex = -1;
    let parentheses = 0;
    let brackets = 0;
    for (let j = i + 1; j < operationIndex; j++) {
      const token = tokens[j]!;
      if (token.kind === "leftParen") parentheses++;
      if (token.kind === "rightParen") parentheses = Math.max(0, parentheses - 1);
      if (token.kind === "leftBracket") brackets++;
      if (token.kind === "rightBracket") brackets = Math.max(0, brackets - 1);
      if (parentheses === 0 && brackets === 0 && tokenLower(token) === "do") {
        doIndex = j;
        break;
      }
      if (parentheses === 0 && brackets === 0 && token.kind === "semicolon") break;
    }
    if (doIndex < 0 || doIndex + 1 > operationIndex || doIndex <= nearestDo) continue;
    const bodyEnd = statementEnd(tokens, doIndex + 1);
    if (operationIndex < doIndex + 1 || operationIndex >= bodyEnd) continue;

    const receiverTokens = tokens.slice(i + 1, doIndex);
    nearestDo = doIndex;
    context = receiverTokens.length === 1 && receiverTokens[0]?.kind === "identifier"
      ? { kind: "receiver", receiver: receiverTokens[0].text }
      : { kind: "ambiguous" };
  }
  return context;
}

export function inspectRecordWriteStatement(source: string): RecordWriteStatementResult {
  const inspected = inspectStatement(source);
  return inspected.match
    ? { statement: inspected.match.statement, reason: null }
    : { statement: null, reason: inspected.reason };
}

export function inspectRecordWriteAtSpan(
  source: string,
  span: NonNullable<StackFrameInfo["statementSpan"]>,
): RecordWriteStatementResult {
  const located = locateStatementSource(source, span);
  if (!located) return { statement: null, reason: "writeStatementUnrecognized" };
  const inspected = inspectStatement(located.content);
  if (!inspected.match) return { statement: null, reason: inspected.reason };
  if (!inspected.match.implicitReceiver) {
    return { statement: inspected.match.statement, reason: null };
  }
  const withContext = explicitWithContext(source, located.start + inspected.match.operationOffset);
  if (withContext.kind === "ambiguous") return { statement: null, reason: "receiverUnsupported" };
  return {
    statement: {
      ...inspected.match.statement,
      receiver: withContext.kind === "receiver" ? withContext.receiver : "Rec",
    },
    reason: null,
  };
}

export function parseRecordWriteStatement(source: string): RecordWriteStatement | null {
  return inspectRecordWriteStatement(source).statement;
}

export function parseRuntimeTableType(typeName: string): RuntimeTableType | null {
  // WIRE: Live BC28 debugger record and RecordRef nodes render TypeName as
  // "Table <name> (<positive id>)" (demos/TYPE-ZOO.md, 2026-07-03).
  const match = /^\s*Table\s+(.+?)\s+\((\d+)\)\s*$/i.exec(typeName);
  if (!match) return null;
  const tableId = Number(match[2]);
  const tableName = match[1]?.trim() ?? "";
  if (!Number.isSafeInteger(tableId) || tableId <= 0 || tableName === "") return null;
  return { tableId, tableName };
}

function cloneStack(stack: StackFrameInfo[], localFile: RecordWriteCollectorOptions["localFile"]): StackFrameInfo[] {
  return stack.map((frame) => {
    const file = frame.file ?? localFile(frame.objectType, frame.objectId);
    return {
      ...frame,
      ...(file ? { file } : {}),
      ...(frame.statementSpan
        ? {
            statementSpan: {
              from: { ...frame.statementSpan.from },
              to: { ...frame.statementSpan.to },
            },
          }
        : {}),
    };
  });
}

function stackKey(stack: StackFrameInfo[]): string {
  return stack.map((frame) => `${frame.objectType}:${frame.objectId}:${frame.methodName}:${frame.line}`).join(">");
}

function receiverKey(receiver: string): string {
  // AL identifiers are case-insensitive. Preserve the first source spelling in the
  // report, but do not split one writer merely because source casing differs.
  return receiver.toLocaleLowerCase("en-US");
}

function safeDetail(error: unknown): string {
  return redactAuthorization(error instanceof Error ? error.message : String(error));
}

export class RecordWriteCollector {
  private phaseValue: RecordWriteStatus["phase"] = "arming";
  private sessionObserved = false;
  private sessionIdValue: number | null = null;
  private tableNameValue: string | null = null;
  private observedWrites = 0;
  private matchedWrites = 0;
  private unrelatedWrites = 0;
  private unresolvedWrites = 0;
  private truncatedValue = false;
  private stopReasonValue: RecordWriteReport["stopReason"] | null = null;
  private accepting = true;
  private finishing = false;
  private shutdownRelease: Promise<boolean> | null = null;
  private paused = false;
  private evidenceLost = false;
  private chain: Promise<void> = Promise.resolve();
  private sourceCache = new Map<string, Promise<SourceRecord | null>>();
  private writers = new Map<string, RecordWriteWriterGroup>();
  private unresolved = new Map<string, RecordWriteUnresolvedGroup>();
  private warnings: string[] = [];

  constructor(private readonly options: RecordWriteCollectorOptions) {}

  get client(): RecordWriteCollectorOptions["client"] {
    return this.options.client;
  }

  onEvent(event: DebuggerEvent): void {
    if (!this.accepting) return;
    this.chain = this.chain
      .then(() => {
        if (this.terminal()) return;
        return this.handleEvent(event);
      })
      .catch((error) => this.fail(`Record-write collector failed: ${safeDetail(error)}`));
  }

  async waitForIdle(): Promise<void> {
    await this.chain;
  }

  status(): RecordWriteStatus {
    return {
      phase: this.phaseValue,
      target: { tableId: this.options.tableId, tableName: this.tableNameValue },
      sessionId: this.sessionIdValue,
      summary: this.summary(),
      truncated: this.truncatedValue,
      warning: this.warnings.at(-1) ?? null,
    };
  }

  async finish(): Promise<RecordWriteReport> {
    // Keep intake open while a release invocation crosses the SignalR connection.
    // Any Break already in flight is enqueued before that invocation settles, after
    // which the serialized chain can be drained without mistaking a quiet local queue
    // for a quiet transport.
    this.finishing = true;
    this.shutdownRelease = this.accepting && !this.terminal()
      ? this.options.client.releaseForShutdown()
      : Promise.resolve(false);
    await this.shutdownRelease;
    await this.drainEvents();
    this.accepting = false;
    if (this.paused) {
      try {
        if (!await this.shutdownRelease) await this.options.client.step("release");
        this.paused = false;
      } catch (error) {
        await this.fail(`Unable to release the paused workload: ${safeDetail(error)}`);
      }
    }
    if (this.stopReasonValue === null) this.stopReasonValue = "finished";
    if (this.phaseValue !== "failed") this.phaseValue = "stopped";
    if (!this.sessionObserved && this.phaseValue !== "failed") {
      this.warnings.push("No debugger session bound during the capture window.");
      this.evidenceLost = true;
    }
    await this.options.client.stop().catch((error) => {
      this.warnings.push(`Debugger cleanup warning: ${safeDetail(error)}`);
    });
    return this.report();
  }

  private terminal(): boolean {
    return this.phaseValue === "failed" || this.stopReasonValue !== null;
  }

  private async drainEvents(): Promise<void> {
    while (true) {
      const pending = this.chain;
      await pending;
      if (pending === this.chain) return;
    }
  }

  private summary(): RecordWriteSummary {
    return {
      observedWrites: this.observedWrites,
      matchedWrites: this.matchedWrites,
      uniqueWriters: this.writers.size,
      unrelatedWrites: this.unrelatedWrites,
      unresolvedWrites: this.unresolvedWrites,
    };
  }

  private report(): RecordWriteReport {
    const outcome = this.phaseValue === "failed"
      ? "failed"
      : this.truncatedValue
        ? "truncated"
        : "completed";
    return {
      target: { tableId: this.options.tableId, tableName: this.tableNameValue },
      outcome,
      stopReason: this.stopReasonValue ?? "finished",
      complete: outcome === "completed" && this.unresolvedWrites === 0 && !this.evidenceLost,
      truncated: this.truncatedValue,
      summary: this.summary(),
      writers: [...this.writers.values()].sort((a, b) => a.firstSequence - b.firstSequence).map((group) => ({
        ...group,
        stack: cloneStack(group.stack, this.options.localFile),
      })),
      unresolved: [...this.unresolved.values()].sort((a, b) => a.firstSequence - b.firstSequence).map((group) => ({
        ...group,
        stack: cloneStack(group.stack, this.options.localFile),
      })),
      warnings: [...this.warnings],
    };
  }

  private async handleEvent(event: DebuggerEvent): Promise<void> {
    if (event.kind === "sessionBound") {
      this.sessionObserved = true;
      this.phaseValue = "collecting";
      this.sessionIdValue = event.sessionId;
      if ("warning" in event) this.warnings.push(event.warning);
      return;
    }
    if (event.kind === "detached") {
      this.sessionObserved = true;
      this.paused = false;
      this.accepting = false;
      this.phaseValue = "stopped";
      if (this.finishing) {
        this.stopReasonValue ??= "finished";
      } else {
        this.stopReasonValue ??= "sessionDetached";
        this.evidenceLost = true;
        this.warnings.push(
          "Debugger session detached before finish; the capture ended early and may exclude later writes.",
        );
      }
      return;
    }
    if (event.kind === "fatal") {
      await this.fail(`Business Central debugger: ${safeDetail(event.message)}`);
      return;
    }
    if (event.kind !== "break") {
      return;
    }

    this.phaseValue = "collecting";
    this.sessionObserved = true;
    this.paused = true;
    const sequence = ++this.observedWrites;
    const stack = cloneStack(event.stack, this.options.localFile);
    if (event.errorMessage) {
      this.recordUnresolved(sequence, stack, "unexpectedBreak", null, null);
    } else {
      await this.classify(sequence, stack);
    }

    if (this.observedWrites >= this.options.maxObservedWrites) {
      this.truncatedValue = true;
      this.evidenceLost = true;
      this.stopReasonValue = "maxObservedWrites";
      this.phaseValue = "stopped";
      this.accepting = false;
      await this.options.client.step("release");
      this.paused = false;
      this.warnings.push(
        `Stopped after maxObservedWrites=${this.options.maxObservedWrites}; the capture is truncated.`,
      );
      return;
    }

    if (this.finishing) {
      this.stopReasonValue = "finished";
      this.phaseValue = "stopped";
      this.accepting = false;
      if (!await this.shutdownRelease) await this.options.client.step("release");
      this.paused = false;
      return;
    }

    await this.options.client.step("continue");
    this.paused = false;
  }

  private async classify(sequence: number, stack: StackFrameInfo[]): Promise<void> {
    const frame = stack[0];
    if (!frame) {
      this.recordUnresolved(sequence, stack, "statementSpanUnavailable", null, null);
      return;
    }
    if (!frame.statementSpan) {
      this.recordUnresolved(sequence, stack, "statementSpanUnavailable", null, null);
      return;
    }
    let source: SourceRecord | null;
    try {
      source = await this.source(frame.objectType, frame.objectId);
    } catch (error) {
      this.recordUnresolved(sequence, stack, "inspectionFailed", null, null);
      this.warnings.push(`Source inspection failed at write ${sequence}: ${safeDetail(error)}`);
      return;
    }
    if (!source) {
      this.recordUnresolved(sequence, stack, "sourceUnavailable", null, null);
      return;
    }
    if (sourceAtStatementSpan(source.content, frame.statementSpan) === null) {
      this.recordUnresolved(sequence, stack, "statementSpanUnavailable", null, null);
      return;
    }
    const inspected = inspectRecordWriteAtSpan(source.content, frame.statementSpan);
    if (!inspected.statement) {
      this.recordUnresolved(sequence, stack, inspected.reason, null, null);
      return;
    }
    const statement = inspected.statement;
    if (!source.trusted) {
      this.recordUnresolved(sequence, stack, "sourceUnavailable", statement.operation, statement.receiver);
      this.warnings.push(
        `Write ${sequence} mapped only to local source; rerun with changesDeployed: true only after publishing that source.`,
      );
      return;
    }
    let node: VariableNode | null;
    try {
      node = await this.options.client.evalWatch(0, statement.receiver);
    } catch (error) {
      this.recordUnresolved(sequence, stack, "inspectionFailed", statement.operation, statement.receiver);
      this.warnings.push(`Receiver inspection failed at write ${sequence}: ${safeDetail(error)}`);
      return;
    }
    if (!node) {
      this.recordUnresolved(sequence, stack, "receiverUnavailable", statement.operation, statement.receiver);
      return;
    }
    const runtime = parseRuntimeTableType(node.typeName);
    if (!runtime) {
      this.recordUnresolved(sequence, stack, "receiverTypeUnresolved", statement.operation, statement.receiver);
      return;
    }
    if (runtime.tableId !== this.options.tableId) {
      this.unrelatedWrites++;
      return;
    }
    if (this.tableNameValue === null) {
      this.tableNameValue = runtime.tableName;
    } else if (this.tableNameValue !== runtime.tableName) {
      this.warnings.push(
        `Target table ${this.options.tableId} was reported with both '${this.tableNameValue}' and '${runtime.tableName}'; keeping the first name.`,
      );
    }
    this.matchedWrites++;
    const provenance: RecordWriteSource = source.source === "deployed" ? "deployed" : "localAsserted";
    const key = `${statement.operation}|${receiverKey(statement.receiver)}|${stackKey(stack)}`;
    const existing = this.writers.get(key);
    if (existing) {
      existing.count++;
      existing.lastSequence = sequence;
    } else {
      this.writers.set(key, {
        operation: statement.operation,
        receiver: statement.receiver,
        count: 1,
        firstSequence: sequence,
        lastSequence: sequence,
        source: provenance,
        stack,
      });
    }
  }

  private source(objectType: number, objectId: number): Promise<SourceRecord | null> {
    const key = `${objectType}:${objectId}`;
    const cached = this.sourceCache.get(key);
    if (cached) return cached;
    const pending = (async () => {
      try {
        const deployed = await this.options.client.getSourceContent(objectType, objectId);
        if (deployed.isAlContent && deployed.content !== "") {
          return { content: deployed.content, source: "deployed", trusted: true } satisfies SourceRecord;
        }
      } catch {
        // Local source remains a possible, explicitly asserted fallback.
      }
      const local = await this.options.localSource(objectType, objectId);
      if (local === null) return null;
      return {
        content: local,
        source: "local",
        trusted: this.options.changesDeployed,
      } satisfies SourceRecord;
    })();
    this.sourceCache.set(key, pending);
    return pending;
  }

  private recordUnresolved(
    sequence: number,
    stack: StackFrameInfo[],
    reason: RecordWriteUnresolvedReason,
    operation: RecordWriteOperation | null,
    receiver: string | null,
  ): void {
    this.unresolvedWrites++;
    this.evidenceLost = true;
    const key = `${reason}|${operation ?? ""}|${receiver ?? ""}|${stackKey(stack)}`;
    const existing = this.unresolved.get(key);
    if (existing) {
      existing.count++;
      existing.lastSequence = sequence;
    } else {
      this.unresolved.set(key, {
        reason,
        operation,
        receiver,
        count: 1,
        firstSequence: sequence,
        lastSequence: sequence,
        stack,
      });
    }
  }

  private async fail(message: string): Promise<void> {
    if (this.phaseValue === "failed") return;
    this.accepting = false;
    this.phaseValue = "failed";
    this.stopReasonValue = "fatal";
    this.evidenceLost = true;
    this.warnings.push(message);
    if (this.paused) {
      await this.options.client.step("release").catch(() => {});
      this.paused = false;
    }
    await this.options.client.stop().catch(() => {});
  }
}
