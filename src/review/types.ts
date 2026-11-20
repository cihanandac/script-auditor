import { z } from 'zod';
import type { Analysis } from '../analyze.js';

export interface ReviewRequest {
  url: string;
  host: string;
  /** Pages of the audited site that run the script. */
  pages: string[];
  newHost: boolean;
  analysis: Analysis;
}

export const reviewResultSchema = z.object({
  verdict: z.enum(['benign', 'suspicious', 'malicious']),
  confidence: z.number(),
  summary: z.string(),
  reasons: z.array(z.string()),
});

export type ReviewResult = z.infer<typeof reviewResultSchema>;

/** The same schema as JSON Schema, for providers with structured output. */
export const reviewResultJsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['verdict', 'confidence', 'summary', 'reasons'],
  properties: {
    verdict: { type: 'string', enum: ['benign', 'suspicious', 'malicious'] },
    confidence: { type: 'number', description: 'Between 0 and 1' },
    summary: { type: 'string', description: 'One sentence' },
    reasons: { type: 'array', items: { type: 'string' }, description: 'At most five' },
  },
} as const;

export interface Reviewer {
  readonly provider: string;
  readonly model: string;
  review(request: ReviewRequest): Promise<ReviewResult>;
}

/** Validates and tidies what a model returned. */
export function normalizeResult(raw: unknown): ReviewResult {
  const result = reviewResultSchema.parse(raw);
  return {
    verdict: result.verdict,
    confidence: Math.min(1, Math.max(0, result.confidence)),
    summary: result.summary.trim().slice(0, 500),
    reasons: result.reasons
      .map((reason) => reason.trim())
      .filter(Boolean)
      .slice(0, 5)
      .map((reason) => reason.slice(0, 300)),
  };
}
