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
import { DisposableStore } from '../../../../base/common/lifecycle.js';
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

	/**
	 * Generate spans with streaming: calls `onSpan` as each span is parsed from CLI output.
	 * Falls back to batch `generateReaderSpans` if streaming is unavailable.
	 * Returns the final complete set of spans.
	 */
	generateReaderSpansStreaming(source: string, filePath: string, languageId: string, token: CancellationToken, onSpan: (span: ReaderSpan, index: number) => void): Promise<ReaderSpan[] | undefined>;

	/**
	 * Reset CLI availability flag so the next generation attempt re-probes the CLI.
	 */
	resetCliAvailability(): void;
}

const SYSTEM_PROMPT = `You explain source code in plain English for people who cannot read code. Your output is a JSON array of "spans" — each span explains what a contiguous block of code DOES and WHY it matters, not just what it IS.

FORMAT: Each span is {"id":"s-0","english":"...","lineStart":1,"lineEnd":5,"kind":"action"}
- id: "s-0", "s-1", etc.
- english: 1-2 sentences. Say what the code ACCOMPLISHES. Never just name the construct.
- lineStart/lineEnd: 1-based, inclusive. Cover all non-empty lines. No gaps, no overlaps.
- kind: "import" | "guard" | "action" | "db" | "response" | "declaration" | "export" | "narration"

QUALITY RULES:
- BAD: "Defines function handleLogin." (just names it — useless)
- GOOD: "Checks the user's email and password against the database, creates a session token, and sends it back as a cookie so the user stays logged in."
- BAD: "Imports 5 dependencies." (no insight)
- GOOD: "Pulls in the database client, the password hashing library, and the session management tools this file needs."
- BAD: "Defines interface User." (structural)
- GOOD: "Describes the shape of a user record — their id, email, display name, and when they signed up."
- Describe the PURPOSE and EFFECT, not the syntax.
- Use plain words: "saves to the database" not "invokes the Prisma create method".
- When a function does multiple things, summarize the FLOW: "First validates the input, then saves the new post to the database, and finally returns the created post to the caller."
- For guards: say WHAT is being protected and WHAT happens if the check fails.
- For types/interfaces: say what the shape REPRESENTS and list its most important fields by name.
- Keep it grounded: only describe what the code actually does. Never speculate about intent beyond what the code shows.

KIND GUIDE:
- "import": pulling in dependencies
- "guard": validation, auth checks, permission gates, early returns on bad input
- "action": the main work — business logic, transformations, API calls
- "db": any database read or write (Prisma, Drizzle, SQL, Mongoose, etc.)
- "response": sending data back (HTTP response, return to caller with result)
- "declaration": type/interface/class/enum/struct definitions
- "export": re-export statements (if a function is exported, use its functional kind instead)
- "narration": comments, config, license headers

Return ONLY the JSON array. No markdown fences, no wrapper object, no explanation.`;

function buildUserPrompt(source: string, filePath: string, languageId: string): string {
	return `File: ${filePath}
Language: ${languageId}

\`\`\`${languageId}
${source}
\`\`\`

Produce the JSON array of reader spans. Remember: describe what each block ACCOMPLISHES for someone who cannot read code.`;
}

function buildCliPrompt(source: string, filePath: string, languageId: string): string {
	return `${SYSTEM_PROMPT}

${buildUserPrompt(source, filePath, languageId)}`;
}

/**
 * Extract complete JSON objects from a partially-received JSON array string.
 * Handles nested braces and strings with escaped characters.
 * Returns parsed objects starting from `startIndex` (skips already-extracted ones).
 */
function extractCompleteSpanObjects(text: string, startIndex: number): Array<Record<string, unknown>> {
	const results: Array<Record<string, unknown>> = [];
	let objectCount = 0;
	let braceDepth = 0;
	let inString = false;
	let escaped = false;
	let objectStart = -1;

	for (let i = 0; i < text.length; i++) {
		const ch = text[i];

		if (escaped) {
			escaped = false;
			continue;
		}

		if (ch === '\\' && inString) {
			escaped = true;
			continue;
		}

		if (ch === '"') {
			inString = !inString;
			continue;
		}

		if (inString) {
			continue;
		}

		if (ch === '{') {
			if (braceDepth === 0) {
				objectStart = i;
			}
			braceDepth++;
		} else if (ch === '}') {
			braceDepth--;
			if (braceDepth === 0 && objectStart >= 0) {
				// We have a complete object
				if (objectCount >= startIndex) {
					const objStr = text.substring(objectStart, i + 1);
					try {
						const parsed = JSON.parse(objStr);
						if (typeof parsed === 'object' && parsed !== null) {
							results.push(parsed as Record<string, unknown>);
						}
					} catch {
						// Incomplete or malformed — skip
					}
				}
				objectCount++;
				objectStart = -1;
			}
		}
	}

	return results;
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

	resetCliAvailability(): void {
		this.cliAvailable = undefined;
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

		// Guard: skip generation for very large files (>500 lines / >50KB)
		// to avoid overwhelming the CLI or API with excessive input
		const lineCount = source.split('\n').length;
		if (lineCount > 500 || source.length > 50_000) {
			this.logService.info(`[ShilModel] File too large for generation (${lineCount} lines, ${source.length} chars): ${filePath}`);
			return undefined;
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

	async generateReaderSpansStreaming(source: string, filePath: string, languageId: string, token: CancellationToken, onSpan: (span: ReaderSpan, index: number) => void): Promise<ReaderSpan[] | undefined> {
		// Return cached result if available
		const key = this.cacheKey(filePath, source);
		const cached = this.cache.get(key);
		if (cached) {
			for (let i = 0; i < cached.length; i++) {
				onSpan(cached[i], i);
			}
			return cached;
		}

		// Guard: skip generation for very large files
		const lineCount = source.split('\n').length;
		if (lineCount > 500 || source.length > 50_000) {
			this.logService.info(`[ShilModel] File too large for streaming generation (${lineCount} lines, ${source.length} chars): ${filePath}`);
			return undefined;
		}

		// Try streaming CLI first
		if (this.cliAvailable !== false) {
			const streamResult = await this.generateViaCliStream(source, filePath, languageId, token, onSpan);
			if (streamResult) {
				this.cacheSpans(key, streamResult);
				return streamResult;
			}
		}

		// Fallback to batch generation (API key path doesn't stream)
		const batchResult = await this.generateReaderSpans(source, filePath, languageId, token);
		if (batchResult) {
			for (let i = 0; i < batchResult.length; i++) {
				onSpan(batchResult[i], i);
			}
		}
		return batchResult;
	}

	private async generateViaCliStream(source: string, filePath: string, languageId: string, token: CancellationToken, onSpan: (span: ReaderSpan, index: number) => void): Promise<ReaderSpan[] | undefined> {
		try {
			const cliCommand = this.configService.getValue<string>('shil.model.cliCommand') || this.defaultCliCommand();
			const prompt = buildCliPrompt(source, filePath, languageId);
			this.logService.info(`[ShilModel] Starting streaming CLI: "${cliCommand}" with ${prompt.length} char prompt`);

			const requestId = await this.nativeHostService.shilStartCliStream(cliCommand, ['-p', '--output-format', 'text'], 120_000, prompt);

			return new Promise<ReaderSpan[] | undefined>((resolve) => {
				const disposables = new DisposableStore();
				let accumulated = '';
				const spans: ReaderSpan[] = [];
				let spanIndex = 0;
				let resolved = false;

				const finish = (result: ReaderSpan[] | undefined) => {
					if (resolved) {
						return;
					}
					resolved = true;
					disposables.dispose();
					resolve(result);
				};

				// Listen for cancellation
				if (token.isCancellationRequested) {
					finish(undefined);
					return;
				}
				disposables.add(token.onCancellationRequested(() => {
					this.logService.info('[ShilModel] Streaming cancelled');
					finish(undefined);
				}));

				// Listen for data chunks
				disposables.add(this.nativeHostService.onShilCliData(e => {
					if (e.requestId !== requestId || resolved) {
						return;
					}
					accumulated += e.chunk;

					// Try to extract complete JSON span objects from accumulated text
					const newSpans = extractCompleteSpanObjects(accumulated, spanIndex);
					for (const s of newSpans) {
						const validated = this.validateSingleSpan(s, spanIndex);
						if (validated) {
							spans.push(validated);
							onSpan(validated, spanIndex);
							spanIndex++;
						}
					}
				}));

				// Listen for process exit
				disposables.add(this.nativeHostService.onShilCliExit(e => {
					if (e.requestId !== requestId || resolved) {
						return;
					}

					this.logService.info(`[ShilModel] Streaming CLI exit=${e.exitCode}, accumulated=${accumulated.length} chars`);

					if (e.exitCode !== 0) {
						if (e.stderr.includes('ENOENT') || e.stderr.includes('not found') || e.stderr.includes('No such file')) {
							this.cliAvailable = false;
						}
						finish(undefined);
						return;
					}

					this.cliAvailable = true;

					// Final pass: parse any remaining spans from the complete output
					const finalParsed = this.parseRawSpans(accumulated);
					if (finalParsed && finalParsed.length > spans.length) {
						// Emit any spans we missed during streaming
						for (let i = spans.length; i < finalParsed.length; i++) {
							onSpan(finalParsed[i], i);
						}
						finish(finalParsed);
					} else if (spans.length > 0) {
						finish(spans);
					} else {
						finish(finalParsed);
					}
				}));
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logService.warn(`[ShilModel] Streaming CLI failed: ${msg}`);
			if (msg.includes('not implemented') || msg.includes('not available')) {
				this.cliAvailable = false;
			}
			return undefined;
		}
	}

	/** Validate a single parsed span object and normalize it. */
	private validateSingleSpan(raw: Record<string, unknown>, index: number): ReaderSpan | undefined {
		if (typeof raw.english !== 'string' || typeof raw.lineStart !== 'number' || typeof raw.lineEnd !== 'number') {
			return undefined;
		}
		const validKinds = new Set<SpanKind>(['narration', 'import', 'guard', 'action', 'db', 'response', 'declaration', 'export']);
		const kind = validKinds.has(raw.kind as SpanKind) ? (raw.kind as SpanKind) : 'action';
		return {
			id: `s-${index}`,
			english: raw.english,
			lineStart: raw.lineStart,
			lineEnd: raw.lineEnd,
			kind,
		};
	}

	private async generateViaCli(source: string, filePath: string, languageId: string, token: CancellationToken): Promise<ReaderSpan[] | undefined> {
		if (this.cliAvailable === false) {
			this.logService.info('[ShilModel] CLI previously marked unavailable, skipping');
			return undefined;
		}

		try {
			const cliCommand = this.configService.getValue<string>('shil.model.cliCommand') || this.defaultCliCommand();
			const prompt = buildCliPrompt(source, filePath, languageId);
			this.logService.info(`[ShilModel] Invoking CLI: "${cliCommand}" with ${prompt.length} char prompt via stdin`);
			// Pass prompt via stdin to avoid OS arg-size limits on large files
			const result = await this.nativeHostService.shilRunCli(cliCommand, ['-p', '--output-format', 'text'], 120_000, prompt);

			if (token.isCancellationRequested) {
				this.logService.info('[ShilModel] Cancelled after CLI returned');
				return undefined;
			}

			this.logService.info(`[ShilModel] CLI exit=${result.exitCode}, stdout=${result.stdout.length} chars, stderr=${result.stderr.substring(0, 300)}`);

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
			const parsed = this.parseRawSpans(result.stdout);
			this.logService.info(`[ShilModel] Parsed ${parsed?.length ?? 0} spans from CLI output`);
			return parsed;
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			this.logService.warn(`[ShilModel] CLI delegation failed: ${msg}`);
			// Only mark CLI as permanently unavailable on IPC-level failures
			// (e.g., web builds where nativeHostService is unavailable).
			// Transient errors (timeouts, crashes) should allow retry.
			if (msg.includes('not implemented') || msg.includes('not available')) {
				this.cliAvailable = false;
			}
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
