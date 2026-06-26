/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CancellationToken } from '../../../../base/common/cancellation.js';
import { streamToBuffer } from '../../../../base/common/buffer.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { IRequestService } from '../../../../platform/request/common/request.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import type { ReaderSpan, SpanKind } from './shilReaderTypes.js';

export const IShilModelService = createDecorator<IShilModelService>('shilModelService');

export interface IShilModelService {
	readonly _serviceBrand: undefined;

	/**
	 * Whether the model service is configured (has an API key and endpoint).
	 */
	isConfigured(): boolean;

	/**
	 * Generate grounded plain-English reader spans from source code.
	 * Returns `undefined` if not configured — caller falls back to regex parser.
	 */
	generateReaderSpans(source: string, filePath: string, languageId: string, token: CancellationToken): Promise<ReaderSpan[] | undefined>;
}

const SYSTEM_PROMPT = `You are a code reader that explains source code in plain English. Given a source file, produce a JSON array of "spans" where each span explains a contiguous block of code.

Rules:
1. Every span must be grounded in the actual code — describe only what the code at those lines does.
2. Use simple, clear English a non-developer can understand.
3. Each span has: id (string, "s-0", "s-1", ...), english (plain-English description), lineStart (1-based), lineEnd (1-based inclusive), kind (one of: "narration", "import", "guard", "action", "db", "response", "declaration", "export").
4. Spans must cover all non-empty lines without gaps or overlaps.
5. Kind classification:
   - "import": import/require statements
   - "guard": validation, auth checks, early returns, error handling
   - "action": business logic, function calls, computations
   - "db": database operations (Prisma, Drizzle, SQL, Mongoose, etc.)
   - "response": HTTP responses, return values sent to clients
   - "declaration": type/interface/class/enum declarations
   - "export": export statements
   - "narration": comments, config, or other descriptive code
6. Return ONLY the JSON array, no markdown fences, no explanation.`;

function buildUserPrompt(source: string, filePath: string, languageId: string): string {
	return `File: ${filePath}
Language: ${languageId}

\`\`\`${languageId}
${source}
\`\`\`

Produce the JSON array of reader spans for this file.`;
}

export class ShilModelService implements IShilModelService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@IConfigurationService private readonly configService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
	) {}

	isConfigured(): boolean {
		const apiKey = this.configService.getValue<string>('shil.model.apiKey');
		return typeof apiKey === 'string' && apiKey.length > 0;
	}

	async generateReaderSpans(source: string, filePath: string, languageId: string, token: CancellationToken): Promise<ReaderSpan[] | undefined> {
		if (!this.isConfigured()) {
			return undefined;
		}

		const apiKey = this.configService.getValue<string>('shil.model.apiKey') ?? '';
		const provider = this.configService.getValue<string>('shil.model.provider') ?? 'openai';
		const endpoint = this.configService.getValue<string>('shil.model.endpoint') || this.defaultEndpoint(provider);
		const model = this.configService.getValue<string>('shil.model.model') || this.defaultModel(provider);

		try {
			const body = this.buildRequestBody(provider, model, source, filePath, languageId);
			const headers = this.buildHeaders(provider, apiKey);

			const response = await this.requestService.request({
				type: 'POST',
				url: endpoint,
				headers,
				data: body,
				callSite: 'shilModelService',
			}, token);

			if (response.res.statusCode && response.res.statusCode >= 400) {
				const errorBuf = await streamToBuffer(response.stream);
				const errorText = errorBuf.toString();
				this.logService.warn(`[ShilModel] API error ${response.res.statusCode}: ${errorText}`);
				return undefined;
			}

			const buf = await streamToBuffer(response.stream);
			const responseText = buf.toString();
			return this.parseResponse(provider, responseText);
		} catch (err) {
			this.logService.warn(`[ShilModel] Request failed: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}

	private defaultEndpoint(provider: string): string {
		switch (provider) {
			case 'anthropic': return 'https://api.anthropic.com/v1/messages';
			case 'ollama': return 'http://localhost:11434/v1/chat/completions';
			default: return 'https://api.openai.com/v1/chat/completions';
		}
	}

	private defaultModel(provider: string): string {
		switch (provider) {
			case 'anthropic': return 'sonnet-4-20250514';
			case 'ollama': return 'llama3.2';
			default: return 'gpt-4o-mini';
		}
	}

	private buildHeaders(provider: string, apiKey: string): Record<string, string> {
		const headers: Record<string, string> = {
			'Content-Type': 'application/json',
		};
		if (provider === 'anthropic') {
			headers['x-api-key'] = apiKey;
			headers['anthropic-version'] = '2023-06-01';
		} else {
			// OpenAI-compatible (openai, ollama, etc.)
			headers['Authorization'] = `Bearer ${apiKey}`;
		}
		return headers;
	}

	private buildRequestBody(provider: string, model: string, source: string, filePath: string, languageId: string): string {
		const userMessage = buildUserPrompt(source, filePath, languageId);

		if (provider === 'anthropic') {
			return JSON.stringify({
				model,
				max_tokens: 4096,
				system: SYSTEM_PROMPT,
				messages: [
					{ role: 'user', content: userMessage },
				],
			});
		}

		// OpenAI-compatible format (works with OpenAI, Ollama, etc.)
		return JSON.stringify({
			model,
			messages: [
				{ role: 'system', content: SYSTEM_PROMPT },
				{ role: 'user', content: userMessage },
			],
			temperature: 0.2,
			response_format: { type: 'json_object' },
		});
	}

	private parseResponse(provider: string, responseText: string): ReaderSpan[] | undefined {
		try {
			const json = JSON.parse(responseText);
			let content: string;

			if (provider === 'anthropic') {
				// Anthropic: { content: [{ type: "text", text: "..." }] }
				content = json.content?.[0]?.text ?? '';
			} else {
				// OpenAI-compatible: { choices: [{ message: { content: "..." } }] }
				content = json.choices?.[0]?.message?.content ?? '';
			}

			// Strip markdown fences if present
			content = content.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();

			// Parse as JSON — might be { spans: [...] } or just [...]
			const parsed = JSON.parse(content);
			const spans: unknown[] = Array.isArray(parsed) ? parsed : (parsed.spans ?? parsed.data ?? []);

			// Validate and normalize
			const validKinds = new Set<SpanKind>(['narration', 'import', 'guard', 'action', 'db', 'response', 'declaration', 'export']);
			const result: ReaderSpan[] = [];
			for (let i = 0; i < spans.length; i++) {
				const s = spans[i] as Record<string, unknown>;
				if (!s || typeof s.english !== 'string' || typeof s.lineStart !== 'number' || typeof s.lineEnd !== 'number') {
					continue;
				}
				const kind = validKinds.has(s.kind as SpanKind) ? (s.kind as SpanKind) : 'action';
				result.push({
					id: `s-${i}`,
					english: s.english,
					lineStart: s.lineStart,
					lineEnd: s.lineEnd,
					kind,
				});
			}

			if (result.length === 0) {
				this.logService.warn('[ShilModel] LLM returned no valid spans');
				return undefined;
			}

			return result;
		} catch (err) {
			this.logService.warn(`[ShilModel] Failed to parse response: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}
}
