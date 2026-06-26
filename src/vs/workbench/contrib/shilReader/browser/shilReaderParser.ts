/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from '../../../../base/common/path.js';
import type { ReaderDoc, ReaderSpan, SpanKind } from './shilReaderTypes.js';

/**
 * v0 structural parser: regex-based detection of code blocks (imports,
 * functions, classes, exports, etc.) with grounded plain-English descriptions.
 * Future versions will use tree-sitter for precise AST analysis and LLM
 * phrasing for richer prose.
 */
export function parseToReaderDoc(source: string, filePath: string, languageId: string): ReaderDoc {
	const lines = source.split('\n');
	const spans: ReaderSpan[] = [];
	let spanIdx = 0;

	let i = 0;
	while (i < lines.length) {
		// Skip blank lines
		if (lines[i].trim() === '') {
			i++;
			continue;
		}

		// Detect import blocks
		if (isImportLine(lines[i])) {
			const start = i;
			while (i < lines.length && (isImportLine(lines[i]) || lines[i].trim() === '')) {
				i++;
			}
			// Trim trailing blank lines
			let end = i - 1;
			while (end > start && lines[end].trim() === '') {
				end--;
			}
			const importCount = countImports(lines, start, end);
			spans.push(makeSpan(spanIdx++, start + 1, end + 1, 'import',
				`Brings in ${importCount} ${importCount === 1 ? 'dependency' : 'dependencies'} this file needs.`));
			continue;
		}

		// Detect function/method declarations (including multi-line signatures)
		const funcMatch = matchFunction(lines, i);
		if (funcMatch) {
			const start = i;
			const end = findBlockEnd(lines, funcMatch.bodyLine);
			const exported = lines[start].trimStart().startsWith('export');
			const params = funcMatch.params;
			const bodyText = lines.slice(funcMatch.bodyLine, end + 1).join('\n');
			const bodyKind = classifyBodyKind(bodyText, funcMatch.name);
			const kindForSpan = exported && bodyKind === 'action' ? 'export' : bodyKind;
			const english = enrichedEnglish(kindForSpan, funcMatch.name, params, exported, funcMatch.async, bodyText, false);
			spans.push(makeSpan(spanIdx++, start + 1, end + 1, kindForSpan, english));
			i = end + 1;
			continue;
		}

		// Detect class declarations — parse methods inside
		const classMatch = lines[i].match(/^(\s*)(export\s+)?(abstract\s+)?class\s+(\w+)/);
		if (classMatch) {
			const classStart = i;
			const classEnd = findBlockEnd(lines, i);
			const exported = !!classMatch[2];
			const abstract = !!classMatch[3];
			const className = classMatch[4];

			// Find the opening brace of the class body
			let bodyStart = classStart;
			for (let b = classStart; b <= classEnd; b++) {
				if (lines[b].includes('{')) {
					bodyStart = b + 1;
					break;
				}
			}

			// Class header span (declaration line + extends/implements)
			spans.push(makeSpan(spanIdx++, classStart + 1, bodyStart, 'declaration',
				`Defines ${exported ? 'an exported ' : ''}${abstract ? 'abstract ' : ''}class "${className}".`));

			// Parse methods/properties inside the class body
			const classIndent = (classMatch[1] || '').length;
			let j = bodyStart;
			while (j < classEnd) {
				if (lines[j].trim() === '' || isCommentLine(lines[j])) {
					j++;
					continue;
				}

				const methodMatch = matchMethod(lines[j], classIndent);
				if (methodMatch) {
					const mStart = j;
					const mEnd = findBlockEnd(lines, j);
					const methodBody = lines.slice(j, mEnd + 1).join('\n');
					const methodKind = classifyBodyKind(methodBody, methodMatch.name);
					const methodEnglish = enrichedEnglish(methodKind, methodMatch.name, '', false, methodMatch.async, methodBody, true, className);
					spans.push(makeSpan(spanIdx++, mStart + 1, mEnd + 1, methodKind, methodEnglish));
					j = mEnd + 1;
					continue;
				}

				// Property/field declarations inside class
				const propMatch = lines[j].match(/^(\s+)(private|protected|public|readonly|static|abstract|override|\s)*(readonly\s+)?(\w+)\s*[=:;?]/);
				if (propMatch && (propMatch[1] || '').length > classIndent) {
					const pStart = j;
					const pEnd = findStatementEnd(lines, j);
					const propName = propMatch[4];
					spans.push(makeSpan(spanIdx++, pStart + 1, pEnd + 1, 'narration',
						`Property "${propName}" of class "${className}".`));
					j = pEnd + 1;
					continue;
				}

				j++;
			}

			i = classEnd + 1;
			continue;
		}

		// Detect interface/type declarations
		const typeMatch = lines[i].match(/^(\s*)(export\s+)?(interface|type)\s+(\w+)/);
		if (typeMatch) {
			const start = i;
			const end = findBlockEnd(lines, i);
			const exported = !!typeMatch[2];
			const kind = typeMatch[3];
			const name = typeMatch[4];
			spans.push(makeSpan(spanIdx++, start + 1, end + 1, 'declaration',
				`Defines ${exported ? 'an exported ' : ''}${kind} "${name}".`));
			i = end + 1;
			continue;
		}

		// Detect const/let/var declarations (especially exported ones)
		const varMatch = lines[i].match(/^(\s*)(export\s+)?(const|let|var)\s+(\w+)/);
		if (varMatch) {
			const start = i;
			const end = findStatementEnd(lines, i);
			const exported = !!varMatch[2];
			const name = varMatch[4];
			spans.push(makeSpan(spanIdx++, start + 1, end + 1, exported ? 'export' : 'narration',
				`${exported ? 'Exports' : 'Declares'} "${name}".`));
			i = end + 1;
			continue;
		}

		// Detect enum declarations
		const enumMatch = lines[i].match(/^(\s*)(export\s+)?enum\s+(\w+)/);
		if (enumMatch) {
			const start = i;
			const end = findBlockEnd(lines, i);
			const exported = !!enumMatch[2];
			const name = enumMatch[3];
			spans.push(makeSpan(spanIdx++, start + 1, end + 1, 'declaration',
				`Defines ${exported ? 'an exported ' : ''}enum "${name}".`));
			i = end + 1;
			continue;
		}

		// Catch-all: comment blocks and other lines
		if (isCommentLine(lines[i])) {
			const start = i;
			while (i < lines.length && (isCommentLine(lines[i]) || lines[i].trim() === '')) {
				i++;
			}
			let end = i - 1;
			while (end > start && lines[end].trim() === '') {
				end--;
			}
			spans.push(makeSpan(spanIdx++, start + 1, end + 1, 'narration',
				'Documentation and comments.'));
			continue;
		}

		// Unknown line — skip
		i++;
	}

	// If no spans were detected, create one that covers the whole file
	if (spans.length === 0 && lines.length > 0) {
		spans.push(makeSpan(0, 1, lines.length, 'narration',
			`This file contains ${lines.length} lines of ${languageId} code.`));
	}

	return {
		title: basename(filePath),
		path: filePath,
		language: languageId,
		source,
		spans,
		connections: [],
	};
}

function makeSpan(idx: number, lineStart: number, lineEnd: number, kind: SpanKind, english: string): ReaderSpan {
	return { id: `s-${idx}`, english, lineStart, lineEnd, kind };
}

/**
 * Generate enriched English prose based on the classified span kind.
 * Guards get "Guards against..." phrasing, db spans get "Reads/Writes from..."
 * phrasing, response spans get "Returns..." phrasing.
 */
function enrichedEnglish(kind: SpanKind, name: string, params: string, exported: boolean, isAsync: boolean, body: string, isMethod: boolean, className?: string): string {
	const location = isMethod && className ? `method "${name}" of class "${className}"` : `function "${name}"`;
	const paramDesc = params ? ` taking ${describeParams(params)}` : '';

	if (kind === 'guard') {
		// Detect guard subtype from body content
		if (/\b(?:getSession|getServerSession|getToken|requireAuth|checkAuth|verifyToken|jwt\.verify)\b/.test(body) ||
			/\b(?:unauthorized|forbidden|unauthenticated)\b/i.test(body) || /\b(?:401|403)\b/.test(body)) {
			return `Guards against unauthorized access in ${location}. Checks credentials before proceeding.`;
		}
		if (/\b(?:z\.object|z\.string|z\.number|yup\.|joi\.|zod\b)/.test(body) || /\.parse\s*\(/.test(body)) {
			return `Validates input${paramDesc} in ${location}. Rejects malformed data before proceeding.`;
		}
		return `Guards: checks preconditions in ${location}${paramDesc}. Returns early if validation fails.`;
	}

	if (kind === 'db') {
		// Detect read vs write
		const hasRead = /\b(?:findMany|findFirst|findUnique|findFirstOrThrow|findUniqueOrThrow|find|findOne|findById|count|aggregate|groupBy)\b/.test(body) ||
			/\bdb\.(?:select|query)\b/.test(body) || /\bSELECT\b/.test(body);
		const hasWrite = /\b(?:create|createMany|update|updateMany|upsert|delete|deleteMany|save|insertMany|updateOne|deleteOne)\b/.test(body) ||
			/\bdb\.(?:insert|update|delete)\b/.test(body) || /\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/.test(body);
		if (hasRead && hasWrite) {
			return `Reads from and writes to the database in ${location}.`;
		}
		if (hasWrite) {
			return `Writes to the database in ${location}.`;
		}
		return `Reads from the database in ${location}.`;
	}

	if (kind === 'response') {
		if (/\bredirect\b/i.test(body)) {
			return `Redirects the client from ${location}.`;
		}
		if (/\b(?:json|NextResponse\.json|res\.json|Response\.json)\b/.test(body)) {
			return `Returns a JSON response from ${location}.`;
		}
		return `Returns a response from ${location}.`;
	}

	// Default: action / export — keep the existing generic phrasing
	const asyncLabel = isAsync ? 'async ' : '';
	return `Defines ${exported ? 'an exported ' : ''}${asyncLabel}${isMethod && className ? `method "${name}" of class "${className}"` : `function "${name}"`}${paramDesc}.`;
}

/**
 * Classify the body of a function or method into a more specific SpanKind.
 * Detects guard patterns (validation, auth, early returns), database operations,
 * and response patterns (NextResponse, res.json, etc.).
 */
function classifyBodyKind(body: string, name: string): SpanKind {
	// Check name-based hints first (strongest signal)
	const lowerName = name.toLowerCase();
	if (/^(auth|validate|check|require|assert|verify|ensure|guard|is[A-Z]|has[A-Z]|can[A-Z])/.test(name) ||
		/^(middleware|protect|restrict|permit|deny|forbid)/.test(lowerName)) {
		return 'guard';
	}

	// Count pattern signals in the body
	let guardSignals = 0;
	let dbSignals = 0;
	let responseSignals = 0;

	// Guard patterns: early returns, throws, status 401/403, validation
	if (/\bthrow\s+new\s+\w*(?:Error|Exception)/i.test(body)) { guardSignals += 2; }
	if (/\bif\s*\([^)]*\)\s*\{?\s*(?:return|throw)\b/.test(body)) { guardSignals += 2; }
	if (/\b(?:401|403|404)\b/.test(body)) { guardSignals += 1; }
	if (/\b(?:unauthorized|forbidden|unauthenticated)\b/i.test(body)) { guardSignals += 2; }
	if (/\b(?:getSession|getServerSession|getToken|requireAuth|checkAuth|verifyToken|jwt\.verify)\b/.test(body)) { guardSignals += 3; }
	if (/\b(?:z\.object|z\.string|z\.number|yup\.|joi\.|zod\b)/.test(body)) { guardSignals += 2; }
	if (/\.parse\s*\(/.test(body) && /\b(?:schema|validator|zod|z\.)\b/.test(body)) { guardSignals += 2; }

	// Database patterns: Prisma, Drizzle, Mongoose, Knex, raw SQL
	if (/\bprisma\.\w+\.(?:findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|create|createMany|update|updateMany|upsert|delete|deleteMany|count|aggregate|groupBy)\b/.test(body)) { dbSignals += 3; }
	if (/\bdb\.(?:select|insert|update|delete|query)\b/.test(body)) { dbSignals += 3; }
	if (/\.(?:find|findOne|findById|save|create|insertMany|updateOne|updateMany|deleteOne|deleteMany|aggregate)\s*\(/.test(body)) { dbSignals += 2; }
	if (/\b(?:SELECT|INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/.test(body)) { dbSignals += 3; }
	if (/\bawait\s+\w+\.(?:query|execute|raw)\s*\(/.test(body)) { dbSignals += 2; }
	if (/\$queryRaw|sql`/.test(body)) { dbSignals += 3; }

	// Response patterns: NextResponse, res.json, Response, return json
	if (/\bNextResponse\.(?:json|redirect|rewrite|next)\s*\(/.test(body)) { responseSignals += 3; }
	if (/\bResponse\.(?:json|redirect)\s*\(/.test(body)) { responseSignals += 3; }
	if (/\bnew\s+Response\s*\(/.test(body)) { responseSignals += 2; }
	if (/\bres\.(?:json|send|status|redirect|render|end)\s*\(/.test(body)) { responseSignals += 3; }
	if (/\breturn\s+(?:json|redirect)\s*\(/.test(body)) { responseSignals += 2; }
	if (/\b(?:json|NextResponse|Response)\s*\(\s*\{/.test(body)) { responseSignals += 1; }

	// Pick the strongest signal (minimum threshold: 2)
	const max = Math.max(guardSignals, dbSignals, responseSignals);
	if (max < 2) {
		return 'action';
	}

	if (guardSignals === max) { return 'guard'; }
	if (dbSignals === max) { return 'db'; }
	if (responseSignals === max) { return 'response'; }

	return 'action';
}

function isImportLine(line: string): boolean {
	const t = line.trimStart();
	return t.startsWith('import ') || t.startsWith('import{') ||
		t.startsWith('from ') ||
		(t.startsWith('const ') && t.includes('require(')) ||
		(t.startsWith('import('));
}

function countImports(lines: string[], start: number, end: number): number {
	let count = 0;
	for (let i = start; i <= end; i++) {
		const t = lines[i].trimStart();
		if (t.startsWith('import ') || t.startsWith('import{') ||
			(t.startsWith('const ') && t.includes('require('))) {
			count++;
		}
	}
	return Math.max(count, 1);
}

function isCommentLine(line: string): boolean {
	const t = line.trimStart();
	return t.startsWith('//') || t.startsWith('/*') || t.startsWith('*') || t.startsWith('#');
}

interface FuncMatch {
	name: string;
	params: string;
	async: boolean;
	/** The line index where the function body (opening brace) starts */
	bodyLine: number;
}

function matchFunction(lines: string[], idx: number): FuncMatch | null {
	const line = lines[idx];
	// Single-line function declaration
	const m = line.match(/^(\s*)(export\s+)?(async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
	if (m) {
		return { name: m[4], params: m[5], async: !!m[3], bodyLine: idx };
	}

	// Multi-line function signature: `function foo(` without closing `)` on same line
	const multiStart = line.match(/^(\s*)(export\s+)?(async\s+)?function\s+(\w+)\s*\(/);
	if (multiStart && !line.includes(')')) {
		const params = collectMultiLineParams(lines, idx);
		const closeLine = findClosingParen(lines, idx);
		return { name: multiStart[4], params, async: !!multiStart[3], bodyLine: closeLine };
	}

	// Arrow function assigned to const
	const arrow = line.match(/^(\s*)(export\s+)?(const|let)\s+(\w+)\s*=\s*(async\s+)?\(/);
	if (arrow) {
		// Check if the closing paren + arrow is on this line or a later line
		if (line.includes(')')) {
			return { name: arrow[4], params: '', async: !!arrow[5], bodyLine: idx };
		}
		const closeLine = findClosingParen(lines, idx);
		return { name: arrow[4], params: '', async: !!arrow[5], bodyLine: closeLine };
	}
	return null;
}

function collectMultiLineParams(lines: string[], start: number): string {
	const parts: string[] = [];
	for (let i = start; i < lines.length; i++) {
		parts.push(lines[i]);
		if (lines[i].includes(')')) {
			break;
		}
	}
	const joined = parts.join(' ');
	const inner = joined.match(/\(([^)]*)\)/);
	return inner ? inner[1] : '';
}

function findClosingParen(lines: string[], start: number): number {
	let depth = 0;
	for (let i = start; i < lines.length; i++) {
		for (const ch of lines[i]) {
			if (ch === '(') {
				depth++;
			} else if (ch === ')') {
				depth--;
				if (depth <= 0) {
					return i;
				}
			}
		}
	}
	return start;
}

function describeParams(params: string): string {
	const parts = params.split(',').map(p => p.trim()).filter(p => p.length > 0);
	if (parts.length === 0) {
		return 'no parameters';
	}
	const names = parts.map(p => {
		const name = p.split(/[:\s=]/)[0].trim();
		return `"${name}"`;
	});
	if (names.length === 1) {
		return names[0];
	}
	return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

function findBlockEnd(lines: string[], start: number): number {
	let depth = 0;
	let foundOpen = false;
	for (let i = start; i < lines.length; i++) {
		for (const ch of lines[i]) {
			if (ch === '{') {
				depth++;
				foundOpen = true;
			} else if (ch === '}') {
				depth--;
			}
		}
		if (foundOpen && depth <= 0) {
			return i;
		}
	}
	return lines.length - 1;
}

interface MethodMatch {
	name: string;
	async: boolean;
	static: boolean;
	visibility: string;
}

function matchMethod(line: string, classIndent: number): MethodMatch | null {
	const t = line.trimStart();
	const indent = line.length - line.trimStart().length;

	// Must be indented deeper than the class
	if (indent <= classIndent) {
		return null;
	}

	// Match: [visibility] [static] [async] [override] methodName(...)
	const m = t.match(/^(private|protected|public)?\s*(static)?\s*(override\s+)?(async\s+)?(get\s+|set\s+)?(\w+)\s*\(/);
	if (m) {
		// Skip 'constructor' label but still capture it
		const name = m[6];
		return {
			name: m[5] ? `${m[5].trim()} ${name}` : name,
			async: !!m[4],
			static: !!m[2],
			visibility: m[1] || '',
		};
	}
	return null;
}

function findStatementEnd(lines: string[], start: number): number {
	// For multi-line statements, track brackets/parens
	let depth = 0;
	for (let i = start; i < lines.length; i++) {
		for (const ch of lines[i]) {
			if (ch === '{' || ch === '(' || ch === '[') {
				depth++;
			} else if (ch === '}' || ch === ')' || ch === ']') {
				depth--;
			}
		}
		if (depth <= 0 && (lines[i].trimEnd().endsWith(';') || lines[i].trimEnd().endsWith(',') || i === lines.length - 1 || (i > start && lines[i + 1]?.trim() === ''))) {
			return i;
		}
	}
	return start;
}
