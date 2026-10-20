export type PlayerId = "A" | "B";
export type Color = "black" | "white";
export type Cell = 0 | 1 | -1;
/** Row-major integer, 0 <= point < boardSize squared. */
export type Point = number;
export type BoardSize = 9 | 13 | 15 | 19;
export type ConfirmationDelay = 0 | 2 | 4 | 6 | 8 | 10 | 12;
export type ClaimMode = "fixed-five" | "color-pressure";
export type RulesVersion = "2.1.0-r3";
export interface RuleConfig {
  readonly rulesVersion: RulesVersion;
  readonly boardSize: BoardSize;
  readonly swap3: boolean;
  readonly confirmationDelay: ConfirmationDelay;
  readonly superko: "positional" | "off";
  readonly directions: "diagonal" | "four";
  readonly claimMode: ClaimMode;
}
export type Owners = Readonly<Record<Color, PlayerId>>;
export type Phase =
  | { readonly kind: "opening"; readonly placed: 0 | 1 | 2 }
  | { readonly kind: "choose" }
  | { readonly kind: "playing"; readonly toMove: Color }
  | { readonly kind: "finished" };
export interface Claim {
  readonly id: string;
  readonly color: Color;
  /** Exactly five fixed points, or empty for color-pressure. */
  readonly points: readonly Point[];
  readonly formedAt: number;
  readonly dueAt: number;
}
export type Outcome =
  | { readonly kind: "win"; readonly winner: PlayerId; readonly color: Color; readonly reason: "line" | "resign" }
  | { readonly kind: "draw"; readonly reason: "two-passes" }
  | { readonly kind: "cancelled"; readonly reason: "opening-cancel" };
export interface MatchState {
  readonly board: readonly Cell[];
  readonly moveLabels: readonly number[];
  readonly phase: Phase;
  readonly owners: Owners | null;
  /** Accepted placements and all passes, including opening placements. */
  readonly ply: number;
  readonly placements: number;
  readonly captures: Readonly<Record<Color, number>>;
  readonly claims: readonly Claim[];
  readonly passStreak: 0 | 1 | 2;
  readonly lastPlacement: Point | null;
  /** Captures of the most recent placement, retained across passes. */
  readonly lastCaptured: readonly Point[];
  readonly outcome: Outcome | null;
}
export type Action =
  | { readonly kind: "place"; readonly actor: PlayerId; readonly point: Point }
  | { readonly kind: "choose-color"; readonly actor: PlayerId; readonly color: Color }
  | { readonly kind: "pass"; readonly actor: PlayerId }
  | { readonly kind: "resign"; readonly actor: PlayerId }
  | { readonly kind: "cancel-opening"; readonly actor: PlayerId; readonly approvedBy: readonly PlayerId[] };
export interface Match {
  readonly rules: RuleConfig;
  readonly configId: string;
  readonly state: MatchState;
  /** Lazily materialized, immutable explicit commands. */
  readonly accepted: readonly Action[];
  /** Initial position then placement positions. Passes add no key. */
  readonly positions: readonly string[];
}
export type GameEvent =
  | { readonly kind: "placed"; readonly color: Color; readonly point: Point; readonly label: number; readonly ply: number }
  | { readonly kind: "captured"; readonly by: Color; readonly points: readonly Point[] }
  | { readonly kind: "claim-started"; readonly claim: Claim }
  | { readonly kind: "claim-cancelled"; readonly claim: Claim; readonly ply: number }
  | { readonly kind: "passed"; readonly color: Color; readonly automatic: boolean; readonly ply: number }
  | { readonly kind: "color-chosen"; readonly owners: Owners }
  | { readonly kind: "phase-changed"; readonly phase: Phase }
  | { readonly kind: "ended"; readonly outcome: Outcome };
export type ErrorCode =
  | "FINISHED" | "INVALID_MATCH" | "INVALID_ACTION" | "WRONG_PHASE" | "WRONG_ACTOR"
  | "OUT_OF_BOUNDS" | "OCCUPIED" | "SUICIDE" | "REPETITION" | "OPENING_CAPTURE"
  | "INVALID_COLOR" | "INVALID_RULES" | "INVALID_RECORD" | "UNSUPPORTED_VERSION"
  | "CONSENT_REQUIRED" | "NO_UNDO" | "INVALID_SESSION" | "COMPETITIVE"
  | "PAUSED" | "STALE_TASK" | "TASK_BUSY" | "STALE_REQUEST" | "CLOSED" | "HINTS_DISABLED";
export interface CoreError {
  readonly code: ErrorCode;
  readonly messageKey: string;
  readonly path?: string;
  readonly cause?: ErrorCode;
}
export type Result<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: CoreError };
export interface Transition { readonly match: Match; readonly events: readonly GameEvent[] }
export interface GroupInfo { readonly color: Color; readonly stones: readonly Point[]; readonly liberties: readonly Point[] }
export interface MatchRecord {
  readonly schemaVersion: 1;
  readonly rulesVersion: RulesVersion;
  readonly rules: RuleConfig;
  readonly actions: readonly Action[];
}
