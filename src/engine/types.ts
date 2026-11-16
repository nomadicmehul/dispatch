/** Classification of what kind of work an issue requires */
export type IssueClassification =
  | "code-fix"
  | "feature"
  | "investigation"
  | "documentation"
  | "audit"
  | "refactor"
  | "unknown";

/** A GitHub issue with parsed metadata */
export interface Issue {
  number: number;
  title: string;
  body: string;
  labels: string[];
  comments: IssueComment[];
  author: string;
  /** GitHub author_association of the issue author (OWNER, MEMBER, COLLABORATOR, CONTRIBUTOR, NONE, ...) */
  authorAssociation?: string;
  url: string;
  createdAt: string;
  reactions: number;
  classification?: IssueClassification;
  priority?: number;
  /** Comments left out of the prompt because their authors are not trusted */
  omittedComments?: number;
  /** Number of comments on GitHub (comments are fetched only for selected issues) */
  commentCount?: number;
}

export interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
  authorAssociation?: string;
}

/** Context about the repository for the AI engine */
export interface RepoContext {
  owner: string;
  repo: string;
  baseBranch: string;
  cwd: string;
  /** Timeout in milliseconds for the solve/investigate operation */
  timeout?: number;
  /** Path to per-issue log file for capturing subprocess output */
  issueLogFile?: string;
  /** Path to write the raw agent transcript (JSONL) to */
  transcriptFile?: string;
  /** Session ID to assign to the agent session, when the engine supports it */
  sessionId?: string;
  /** Spend cap for this solve in USD, when the engine supports it (0 or unset = no cap) */
  maxCostUsd?: number;
  /** Extra shell commands the agent may run, such as the configured verify command */
  allowedCommands?: string[];
  /** Repository brief shared by every session in the run (see orchestrator/repo-brief.ts) */
  repoBrief?: string;
}

/** Engine session metadata captured during a solve */
export interface EngineSession {
  /** The engine's own session ID (e.g. Claude Code's session UUID) */
  id?: string;
  /** Estimated spend in USD, cumulative for the session */
  costUsd?: number;
  /** Agent turns used */
  turns?: number;
  /** Path of the engine's native transcript, when one exists on disk */
  nativeTranscriptPath?: string;
}

/** Events emitted by the AI engine during solving */
export type EngineEvent =
  | { type: "thinking"; message: string }
  | { type: "tool_use"; tool: string; input: string }
  | { type: "progress"; message: string }
  | { type: "result"; result: SolveResult }
  | { type: "error"; error: string };

/** Result of solving a single issue */
export interface SolveResult {
  success: boolean;
  /** Files that were created or modified */
  changedFiles: string[];
  /** AI-generated summary of what was done */
  summary: string;
  /** AI self-assessed confidence score (1-10) */
  confidence: number;
  /** Areas the AI was unsure about */
  uncertainties: string[];
  /** Commit message used */
  commitMessage: string;
  /** Session metadata, when the engine reports it */
  session?: EngineSession;
}

/** A structured issue ready to be posted to GitHub */
export interface StructuredIssue {
  title: string;
  body: string;
  labels: string[];
}

/** The AI engine interface — implement this for each AI backend */
export interface AIEngine {
  readonly name: string;

  /** Solve a code-related issue (fix, feature, refactor) */
  solve(issue: Issue, context: RepoContext): Promise<SolveResult>;

  /** Investigate a non-code issue (research, audit, documentation) */
  investigate(issue: Issue, context: RepoContext): Promise<SolveResult>;

  /**
   * Continue a previous solve with feedback (e.g. failing verification output).
   * Optional — engines without session continuation leave it undefined.
   */
  repair?(issue: Issue, context: RepoContext, previous: SolveResult, feedback: string): Promise<SolveResult>;

  /** Find the engine's own on-disk transcript for a session ID, if it keeps one */
  locateTranscript?(sessionId: string): Promise<string | null>;

  /** Generate a well-structured issue from a freeform description */
  createIssue(description: string, context: RepoContext): Promise<StructuredIssue>;

  /** Classify what type of work an issue requires */
  classifyIssue(issue: Issue): Promise<IssueClassification>;

  /** Score confidence of a completed solution */
  scoreConfidence(issue: Issue, changedFiles: string[]): Promise<{ score: number; uncertainties: string[] }>;
}
