import type { ModelSpec } from "../router/types.js";

/** Priority levels for context budget allocation */
export type ContextPriority = "critical" | "high" | "medium" | "low";

interface BudgetSlot {
  name: string;
  priority: ContextPriority;
  content: string;
  tokenEstimate: number;
}

/** Priority weights — higher priority content is kept, lower is trimmed first */
const PRIORITY_ORDER: ContextPriority[] = ["critical", "high", "medium", "low"];

/**
 * Manages token budget across different context sections.
 * Ensures the total prompt stays within the model's context window.
 *
 * Allocation strategy:
 * - Reserve 25% for model output
 * - Allocate remaining by priority: critical > high > medium > low
 * - Trim lowest-priority content first if over budget
 */
export class ContextBudgetManager {
  private slots: BudgetSlot[] = [];
  private maxTokens: number;
  private reservedForOutput: number;

  constructor(model: ModelSpec, outputReserveFraction: number = 0.25) {
    this.maxTokens = model.maxContextTokens;
    this.reservedForOutput = Math.floor(this.maxTokens * outputReserveFraction);
  }

  /** Available tokens for input */
  get availableTokens(): number {
    return this.maxTokens - this.reservedForOutput;
  }

  /** Currently used tokens */
  get usedTokens(): number {
    return this.slots.reduce((sum, s) => sum + s.tokenEstimate, 0);
  }

  /** Remaining tokens */
  get remainingTokens(): number {
    return this.availableTokens - this.usedTokens;
  }

  /**
   * Add a content section with a priority level.
   * Tokens are estimated at ~4 chars per token.
   */
  addSection(name: string, content: string, priority: ContextPriority): void {
    const tokenEstimate = Math.ceil(content.length / 4);
    this.slots.push({ name, priority, content, tokenEstimate });
  }

  /**
   * Build the final prompt, trimming low-priority content if needed.
   * Returns sections in priority order (critical first).
   */
  build(): string {
    // Sort by priority
    const sorted = [...this.slots].sort(
      (a, b) => PRIORITY_ORDER.indexOf(a.priority) - PRIORITY_ORDER.indexOf(b.priority),
    );

    const result: string[] = [];
    let usedTokens = 0;
    const budget = this.availableTokens;

    for (const slot of sorted) {
      if (usedTokens + slot.tokenEstimate <= budget) {
        result.push(slot.content);
        usedTokens += slot.tokenEstimate;
      } else {
        // Try to include a truncated version
        const remainingTokens = budget - usedTokens;
        if (remainingTokens > 100) {
          const maxChars = remainingTokens * 4;
          const truncated = slot.content.substring(0, maxChars) + "\n[... truncated for context budget]";
          result.push(truncated);
          usedTokens += remainingTokens;
        }
        // Skip remaining slots
        break;
      }
    }

    return result.join("\n\n");
  }

  /** Get a summary of budget allocation */
  getSummary(): Record<string, { tokens: number; priority: ContextPriority }> {
    const summary: Record<string, { tokens: number; priority: ContextPriority }> = {};
    for (const slot of this.slots) {
      summary[slot.name] = { tokens: slot.tokenEstimate, priority: slot.priority };
    }
    return summary;
  }
}
