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
  url: string;
  createdAt: string;
  reactions: number;
  classification?: IssueClassification;
  priority?: number;
}

export interface IssueComment {
  author: string;
  body: string;
  createdAt: string;
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

  /** Generate a well-structured issue from a freeform description */
  createIssue(description: string, context: RepoContext): Promise<StructuredIssue>;

  /** Classify what type of work an issue requires */
  classifyIssue(issue: Issue): Promise<IssueClassification>;

  /** Score confidence of a completed solution */
  scoreConfidence(issue: Issue, changedFiles: string[]): Promise<{ score: number; uncertainties: string[] }>;
}
