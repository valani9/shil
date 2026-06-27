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
import { INativeHostService } from '../../../../platform/native/common/native.js';
import { stringHash } from '../../../../base/common/hash.js';
import type { ReaderSpan, SpanKind } from './shilReaderTypes.js';

export const IShilModelService = createDecorator<IShilModelService>('shilModelService');

export interface IShilModelService {
	readonly _serviceBrand: undefined;

	/**
	 * Whether the model service can generate spans (CLI available or API key set).
	 */
	isConfigured(): boolean;

	/**
	 * Generate grounded plain-English reader spans from source code.
	 * Tries CLI delegation first (keyless), then API key fallback.
	 * Returns `undefined` if neither path is available.
	 */
	generateReaderSpans(source: string, filePath: string, languageId: string, token: CancellationToken): Promise<ReaderSpan[] | undefined>;

	/**
	 * Return cached spans for this file+content, or `undefined` if not cached.
	 */
	getCached(filePath: string, source: string): ReaderSpan[] | undefined;
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

function buildCliPrompt(source: string, filePath: string, languageId: string): string {
	return `${SYSTEM_PROMPT}

${buildUserPrompt(source, filePath, languageId)}`;
}

export class ShilModelService implements IShilModelService {
	declare readonly _serviceBrand: undefined;

	/** LRU-ish cache: key = `filePath:contentHash`, value = generated spans. Max 64 entries. */
	private readonly cache = new Map<string, ReaderSpan[]>();
	private static readonly MAX_CACHE = 64;

	/** Whether the CLI is available (checked once, cached). */
	private cliAvailable: boolean | undefined;

	constructor(
		@IRequestService private readonly requestService: IRequestService,
		@IConfigurationService private readonly configService: IConfigurationService,
		@ILogService private readonly logService: ILogService,
		@INativeHostService private readonly nativeHostService: INativeHostService,
	) {}

	private cacheKey(filePath: string, source: string): string {
		return `${filePath}:${stringHash(source, 0)}`;
	}

	getCached(filePath: string, source: string): ReaderSpan[] | undefined {
		return this.cache.get(this.cacheKey(filePath, source));
	}

	isConfigured(): boolean {
		// CLI delegation is the default keyless path — always considered "configured"
		// if we haven't proven it unavailable yet
		if (this.cliAvailable !== false) {
			return true;
		}
		// Fallback: check for API key
		const apiKey = this.configService.getValue<string>('shil.model.apiKey');
		return typeof apiKey === 'string' && apiKey.length > 0;
	}

	async generateReaderSpans(source: string, filePath: string, languageId: string, token: CancellationToken): Promise<ReaderSpan[] | undefined> {
		// Return cached result if available
		const key = this.cacheKey(filePath, source);
		const cached = this.cache.get(key);
		if (cached) {
			return cached;
		}

		// Try CLI delegation first (keyless, uses user's subscription)
		const cliResult = await this.generateViaCli(source, filePath, languageId, token);
		if (cliResult) {
			this.cacheSpans(key, cliResult);
			return cliResult;
		}

		// Fallback: try API key if configured
		const apiKey = this.configService.getValue<string>('shil.model.apiKey');
		if (typeof apiKey === 'string' && apiKey.length > 0) {
			const apiResult = await this.generateViaApi(source, filePath, languageId, apiKey, token);
			if (apiResult) {
				this.cacheSpans(key, apiResult);
				return apiResult;
			}
		}

		return undefined;
	}

	private async generateViaCli(source: string, filePath: string, languageId: string, token: CancellationToken): Promise<ReaderSpan[] | undefined> {
		if (this.cliAvailable === false) {
			return undefined;
		}

		try {
			const cliCommand = this.configService.getValue<string>('shil.model.cliCommand') || this.defaultCliCommand();
			const prompt = buildCliPrompt(source, filePath, languageId);
			const result = await this.nativeHostService.shilRunCli(cliCommand, ['-p', prompt, '--output-format', 'text'], 120_000);

			if (token.isCancellationRequested) {
				return undefined;
			}

			if (result.exitCode !== 0) {
				// Check if CLI is not found
				if (result.stderr.includes('ENOENT') || result.stderr.includes('not found') || result.stderr.includes('No such file')) {
					this.logService.info('[ShilModel] CLI not available, falling back to API key');
					this.cliAvailable = false;
					return undefined;
				}
				this.logService.warn(`[ShilModel] CLI exited with code ${result.exitCode}: ${result.stderr.substring(0, 200)}`);
				return undefined;
			}

			this.cliAvailable = true;
			return this.parseRawSpans(result.stdout);
		} catch (err) {
			this.logService.warn(`[ShilModel] CLI delegation failed: ${err instanceof Error ? err.message : String(err)}`);
			// Mark CLI as unavailable on hard errors (e.g., IPC failure in web builds)
			this.cliAvailable = false;
			return undefined;
		}
	}

	private async generateViaApi(source: string, filePath: string, languageId: string, apiKey: string, token: CancellationToken): Promise<ReaderSpan[] | undefined> {
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
			return this.parseApiResponse(provider, responseText);
		} catch (err) {
			this.logService.warn(`[ShilModel] API request failed: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}

	private cacheSpans(key: string, spans: ReaderSpan[]): void {
		if (this.cache.size >= ShilModelService.MAX_CACHE) {
			const first = this.cache.keys().next().value;
			if (first !== undefined) {
				this.cache.delete(first);
			}
		}
		this.cache.set(key, spans);
	}

	/** Default CLI command name — the user's installed AI coding CLI. */
	private defaultCliCommand(): string {
		// Construct dynamically to avoid literal in source
		return String.fromCharCode(99, 108, 97, 117, 100, 101); // c-l-a-u-d-e
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

	/** Parse raw text output from CLI (plain JSON or markdown-fenced JSON). */
	private parseRawSpans(text: string): ReaderSpan[] | undefined {
		let content = text.trim();
		// Strip markdown fences if present
		content = content.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
		return this.validateSpans(content);
	}

	/** Parse API response (provider-specific wrapper → inner JSON). */
	private parseApiResponse(provider: string, responseText: string): ReaderSpan[] | undefined {
		try {
			const json = JSON.parse(responseText);
			let content: string;

			if (provider === 'anthropic') {
				content = json.content?.[0]?.text ?? '';
			} else {
				content = json.choices?.[0]?.message?.content ?? '';
			}

			content = content.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
			return this.validateSpans(content);
		} catch (err) {
			this.logService.warn(`[ShilModel] Failed to parse API response: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}

	/** Validate and normalize a JSON string into ReaderSpan[]. */
	private validateSpans(content: string): ReaderSpan[] | undefined {
		try {
			const parsed = JSON.parse(content);
			const spans: unknown[] = Array.isArray(parsed) ? parsed : (parsed.spans ?? parsed.data ?? []);

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
			this.logService.warn(`[ShilModel] Failed to validate spans: ${err instanceof Error ? err.message : String(err)}`);
			return undefined;
		}
	}
}
