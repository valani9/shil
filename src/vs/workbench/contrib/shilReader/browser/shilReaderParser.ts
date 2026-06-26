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

		// Detect function/method declarations
		const funcMatch = matchFunction(lines[i]);
		if (funcMatch) {
			const start = i;
			const end = findBlockEnd(lines, i);
			const exported = lines[start].trimStart().startsWith('export');
			const asyncLabel = funcMatch.async ? 'async ' : '';
			const params = funcMatch.params;
			const paramDesc = params ? ` taking ${describeParams(params)}` : '';
			spans.push(makeSpan(spanIdx++, start + 1, end + 1, exported ? 'export' : 'action',
				`Defines ${exported ? 'an exported ' : ''}${asyncLabel}function "${funcMatch.name}"${paramDesc}.`));
			i = end + 1;
			continue;
		}

		// Detect class declarations
		const classMatch = lines[i].match(/^(\s*)(export\s+)?(abstract\s+)?class\s+(\w+)/);
		if (classMatch) {
			const start = i;
			const end = findBlockEnd(lines, i);
			const exported = !!classMatch[2];
			const abstract = !!classMatch[3];
			const name = classMatch[4];
			spans.push(makeSpan(spanIdx++, start + 1, end + 1, 'declaration',
				`Defines ${exported ? 'an exported ' : ''}${abstract ? 'abstract ' : ''}class "${name}".`));
			i = end + 1;
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
}

function matchFunction(line: string): FuncMatch | null {
	const m = line.match(/^(\s*)(export\s+)?(async\s+)?function\s+(\w+)\s*\(([^)]*)\)/);
	if (m) {
		return { name: m[4], params: m[5], async: !!m[3] };
	}
	// Arrow function assigned to const
	const arrow = line.match(/^(\s*)(export\s+)?(const|let)\s+(\w+)\s*=\s*(async\s+)?\([^)]*\)\s*(=>|:\s*\w+\s*=>)/);
	if (arrow) {
		return { name: arrow[4], params: '', async: !!arrow[5] };
	}
	return null;
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
