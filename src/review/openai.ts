/**
 * OpenAI, and every endpoint that speaks the OpenAI Responses API (set `llm.baseUrl`).
 */
import OpenAI from 'openai';
import { SYSTEM_PROMPT, buildUserPrompt } from './prompt.js';
import type { ReviewRequest, ReviewResult, Reviewer } from './types.js';
import { normalizeResult, reviewResultJsonSchema } from './types.js';

export interface OpenAIReviewerOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  /** For tests. */
  client?: Pick<OpenAI, 'responses'>;
}

export class OpenAIReviewer implements Reviewer {
  readonly provider = 'openai';
  readonly model: string;
  private readonly client: Pick<OpenAI, 'responses'>;

  constructor(options: OpenAIReviewerOptions) {
    this.model = options.model;
    this.client =
      options.client ??
      new OpenAI({
        apiKey: options.apiKey,
        ...(options.baseUrl ? { baseURL: options.baseUrl } : {}),
        timeout: 180_000,
        maxRetries: 2,
      });
  }

  async review(request: ReviewRequest): Promise<ReviewResult> {
    const response = await this.client.responses.create({
      model: this.model,
      instructions: SYSTEM_PROMPT,
      input: buildUserPrompt(request),
      // Script code is the user's business, not training or retention material
      store: false,
      text: {
        format: {
          type: 'json_schema',
          name: 'script_review',
          strict: true,
          schema: reviewResultJsonSchema as unknown as Record<string, unknown>,
        },
      },
    });
    const text = response.output_text;
    if (!text) {
      throw new Error(`${this.model} returned no text (status: ${response.status ?? 'unknown'})`);
    }
    return normalizeResult(JSON.parse(text));
  }
}
