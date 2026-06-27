/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename } from '../../../../base/common/path.js';
import type { ReaderDoc, ReaderSpan, SpanKind } from './shilReaderTypes.js';

/**
 * v0 structural parser: regex-based detection of code blocks (imports,
 * functions, classes, exports, etc.) with grounded plain-English descriptions.
 * Dispatches to language-specific parsers for Python, Go, and Rust.
 * Future versions will use tree-sitter for precise AST analysis and LLM
 * phrasing for richer prose.
 */
export function parseToReaderDoc(source: string, filePath: string, languageId: string): ReaderDoc {
	const lines = source.split('\n');
	let spans: ReaderSpan[];

	switch (languageId) {
		case 'python':
			spans = parsePythonSpans(lines);
			break;
		case 'go':
			spans = parseGoSpans(lines);
			break;
		case 'rust':
			spans = parseRustSpans(lines);
			break;
		default:
			spans = parseJsTsSpans(lines);
			break;
	}

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

// ── JS/TS parser (original) ──────────────────────────────────────────

function parseJsTsSpans(lines: string[]): ReaderSpan[] {
	const spans: ReaderSpan[] = [];
	let spanIdx = 0;

	let i = 0;
	while (i < lines.length) {
		if (lines[i].trim() === '') {
			i++;
			continue;
		}

		if (isJsImportLine(lines[i])) {
			const start = i;
			while (i < lines.length && (isJsImportLine(lines[i]) || lines[i].trim() === '')) {
				i++;
			}
			let end = i - 1;
			while (end > start && lines[end].trim() === '') {
				end--;
			}
			const importCount = countJsImports(lines, start, end);
			spans.push(makeSpan(spanIdx++, start + 1, end + 1, 'import',
				`Brings in ${importCount} ${importCount === 1 ? 'dependency' : 'dependencies'} this file needs.`));
			continue;
		}

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

		const classMatch = lines[i].match(/^(\s*)(export\s+)?(abstract\s+)?class\s+(\w+)/);
		if (classMatch) {
			const classStart = i;
			const classEnd = findBlockEnd(lines, i);
			const exported = !!classMatch[2];
			const abstract = !!classMatch[3];
			const className = classMatch[4];

			let bodyStart = classStart;
			for (let b = classStart; b <= classEnd; b++) {
				if (lines[b].includes('{')) {
					bodyStart = b + 1;
					break;
				}
			}

			spans.push(makeSpan(spanIdx++, classStart + 1, bodyStart, 'declaration',
				`Defines ${exported ? 'an exported ' : ''}${abstract ? 'abstract ' : ''}class "${className}".`));

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

		i++;
	}

	return spans;
}

// ── Python parser ────────────────────────────────────────────────────

function parsePythonSpans(lines: string[]): ReaderSpan[] {
	const spans: ReaderSpan[] = [];
	let spanIdx = 0;

	let i = 0;
	while (i < lines.length) {
		if (lines[i].trim() === '') {
			i++;
			continue;
		}

		// Import blocks: import X / from X import Y
		if (isPythonImportLine(lines[i])) {
			const start = i;
			while (i < lines.length && (isPythonImportLine(lines[i]) || lines[i].trim() === '')) {
				i++;
			}
			let end = i - 1;
			while (end > start && lines[end].trim() === '') {
				end--;
			}
			const count = countPythonImports(lines, start, end);
			spans.push(makeSpan(spanIdx++, start + 1, end + 1, 'import',
				`Brings in ${count} ${count === 1 ? 'dependency' : 'dependencies'} this file needs.`));
			continue;
		}

		// Decorators: collect them and attach to the next def/class
		if (lines[i].trimStart().startsWith('@')) {
			const decoStart = i;
			while (i < lines.length && lines[i].trimStart().startsWith('@')) {
				i++;
			}
			// Fall through — the decorated def/class will be detected below
			// with decoStart as the real start of the span
			if (i < lines.length) {
				const pyDef = matchPythonDef(lines, i);
				if (pyDef) {
					const defEnd = findPythonBlockEnd(lines, i);
					const isAsync = pyDef.async;
					spans.push(makeSpan(spanIdx++, decoStart + 1, defEnd + 1, 'action',
						`Defines ${isAsync ? 'an async ' : ''}function "${pyDef.name}"${pyDef.params ? ` taking ${describeParams(pyDef.params)}` : ''}.`));
					i = defEnd + 1;
					continue;
				}
				const pyCls = matchPythonClass(lines[i]);
				if (pyCls) {
					const clsEnd = findPythonBlockEnd(lines, i);
					spans.push(makeSpan(spanIdx++, decoStart + 1, clsEnd + 1, 'declaration',
						`Defines class "${pyCls}".`));
					i = clsEnd + 1;
					continue;
				}
			}
			// Stray decorator with no def/class — skip
			continue;
		}

		// Function: def name(params):
		const pyDef = matchPythonDef(lines, i);
		if (pyDef) {
			const start = i;
			const end = findPythonBlockEnd(lines, i);
			const isAsync = pyDef.async;
			spans.push(makeSpan(spanIdx++, start + 1, end + 1, 'action',
				`Defines ${isAsync ? 'an async ' : ''}function "${pyDef.name}"${pyDef.params ? ` taking ${describeParams(pyDef.params)}` : ''}.`));
			i = end + 1;
			continue;
		}

		// Class: class Name:
		const pyCls = matchPythonClass(lines[i]);
		if (pyCls) {
			const start = i;
			const end = findPythonBlockEnd(lines, i);
			spans.push(makeSpan(spanIdx++, start + 1, end + 1, 'declaration',
				`Defines class "${pyCls}".`));
			i = end + 1;
			continue;
		}

		// Comments: # lines or docstrings (triple-quoted)
		if (isPythonCommentLine(lines[i])) {
			const start = i;
			// Triple-quote docstrings
			const tq = lines[i].trimStart();
			if (tq.startsWith('"""') || tq.startsWith("'''")) {
				const quote = tq.slice(0, 3);
				// Single-line docstring
				if (tq.indexOf(quote, 3) >= 0) {
					spans.push(makeSpan(spanIdx++, start + 1, start + 1, 'narration', 'Documentation.'));
					i++;
					continue;
				}
				// Multi-line docstring
				i++;
				while (i < lines.length && !lines[i].includes(quote)) {
					i++;
				}
				if (i < lines.length) {
					i++; // skip closing line
				}
				spans.push(makeSpan(spanIdx++, start + 1, i, 'narration', 'Documentation.'));
				continue;
			}
			// Hash comments
			while (i < lines.length && (lines[i].trimStart().startsWith('#') || lines[i].trim() === '')) {
				i++;
			}
			let end = i - 1;
			while (end > start && lines[end].trim() === '') {
				end--;
			}
			spans.push(makeSpan(spanIdx++, start + 1, end + 1, 'narration', 'Documentation and comments.'));
			continue;
		}

		// Variable assignment at module level: NAME = ...
		const pyVar = lines[i].match(/^(\w+)\s*[:=]/);
		if (pyVar && lines[i][0] !== ' ' && lines[i][0] !== '\t') {
			const start = i;
			const end = findPythonStatementEnd(lines, i);
			spans.push(makeSpan(spanIdx++, start + 1, end + 1, 'narration',
				`Declares "${pyVar[1]}".`));
			i = end + 1;
			continue;
		}

		i++;
	}

	return spans;
}

function isPythonImportLine(line: string): boolean {
	const t = line.trimStart();
	return t.startsWith('import ') || t.startsWith('from ');
}

function countPythonImports(lines: string[], start: number, end: number): number {
	let count = 0;
	for (let i = start; i <= end; i++) {
		const t = lines[i].trimStart();
		if (t.startsWith('import ') || t.startsWith('from ')) {
			count++;
		}
	}
	return Math.max(count, 1);
}

function isPythonCommentLine(line: string): boolean {
	const t = line.trimStart();
	return t.startsWith('#') || t.startsWith('"""') || t.startsWith("'''");
}

interface PyDefMatch {
	name: string;
	params: string;
	async: boolean;
}

function matchPythonDef(lines: string[], idx: number): PyDefMatch | null {
	const m = lines[idx].match(/^(\s*)(async\s+)?def\s+(\w+)\s*\(([^)]*)\)/);
	if (m) {
		return { name: m[3], params: m[4], async: !!m[2] };
	}
	// Multi-line signature: def name( without closing )
	const multi = lines[idx].match(/^(\s*)(async\s+)?def\s+(\w+)\s*\(/);
	if (multi && !lines[idx].includes(')')) {
		const params = collectMultiLineParams(lines, idx);
		return { name: multi[3], params, async: !!multi[2] };
	}
	return null;
}

function matchPythonClass(line: string): string | null {
	const m = line.match(/^class\s+(\w+)/);
	return m ? m[1] : null;
}

function findPythonBlockEnd(lines: string[], start: number): number {
	const baseIndent = lines[start].length - lines[start].trimStart().length;
	let end = start;
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i].trim() === '') {
			continue;
		}
		const indent = lines[i].length - lines[i].trimStart().length;
		if (indent <= baseIndent) {
			break;
		}
		end = i;
	}
	return end;
}

function findPythonStatementEnd(lines: string[], start: number): number {
	// Handles continuation lines (ending with \) and multi-line brackets
	let depth = 0;
	for (let i = start; i < lines.length; i++) {
		for (const ch of lines[i]) {
			if (ch === '(' || ch === '[' || ch === '{') { depth++; }
			else if (ch === ')' || ch === ']' || ch === '}') { depth--; }
		}
		if (depth <= 0 && !lines[i].trimEnd().endsWith('\\')) {
			return i;
		}
	}
	return start;
}

// ── Go parser ────────────────────────────────────────────────────────

function parseGoSpans(lines: string[]): ReaderSpan[] {
	const spans: ReaderSpan[] = [];
	let spanIdx = 0;

	let i = 0;
	while (i < lines.length) {
		if (lines[i].trim() === '') {
			i++;
			continue;
		}

		// Package declaration
		const pkgMatch = lines[i].match(/^package\s+(\w+)/);
		if (pkgMatch) {
			spans.push(makeSpan(spanIdx++, i + 1, i + 1, 'declaration',
				`Package "${pkgMatch[1]}".`));
			i++;
			continue;
		}

		// Import block: import "pkg" or import ( ... )
		if (lines[i].trimStart().startsWith('import ') || lines[i].trimStart() === 'import (') {
			const start = i;
			if (lines[i].includes('(')) {
				// Multi-line import block
				while (i < lines.length && !lines[i].includes(')')) {
					i++;
				}
				i++; // skip closing )
			} else {
				i++; // single import line
			}
			const count = Math.max(1, i - start - (lines[start].includes('(') ? 2 : 0));
			spans.push(makeSpan(spanIdx++, start + 1, i, 'import',
				`Brings in ${count} ${count === 1 ? 'dependency' : 'dependencies'} this file needs.`));
			continue;
		}

		// Function: func name(params) [returnType] {
		const goFunc = lines[i].match(/^func\s+(\w+)\s*\(([^)]*)\)/);
		if (goFunc) {
			const start = i;
			const end = findBlockEnd(lines, i);
			spans.push(makeSpan(spanIdx++, start + 1, end + 1, 'action',
				`Defines function "${goFunc[1]}"${goFunc[2] ? ` taking ${describeParams(goFunc[2])}` : ''}.`));
			i = end + 1;
			continue;
		}

		// Method: func (r *Receiver) name(params) {
		const goMethod = lines[i].match(/^func\s+\(\s*\w+\s+\*?(\w+)\s*\)\s+(\w+)\s*\(([^)]*)\)/);
		if (goMethod) {
			const start = i;
			const end = findBlockEnd(lines, i);
			spans.push(makeSpan(spanIdx++, start + 1, end + 1, 'action',
				`Defines method "${goMethod[2]}" on "${goMethod[1]}".`));
			i = end + 1;
			continue;
		}

		// Type declaration: type Name struct/interface { ... }
		const goType = lines[i].match(/^type\s+(\w+)\s+(struct|interface)\b/);
		if (goType) {
			const start = i;
			const end = findBlockEnd(lines, i);
			spans.push(makeSpan(spanIdx++, start + 1, end + 1, 'declaration',
				`Defines ${goType[2]} "${goType[1]}".`));
			i = end + 1;
			continue;
		}

		// Type alias: type Name = ... or type Name sometype
		const goAlias = lines[i].match(/^type\s+(\w+)\s+/);
		if (goAlias) {
			spans.push(makeSpan(spanIdx++, i + 1, i + 1, 'declaration',
				`Defines type "${goAlias[1]}".`));
			i++;
			continue;
		}

		// Const/var blocks
		const goConst = lines[i].match(/^(const|var)\s/);
		if (goConst) {
			const start = i;
			if (lines[i].includes('(')) {
				while (i < lines.length && !lines[i].includes(')')) {
					i++;
				}
				i++;
			} else {
				i++;
			}
			const declKind = goConst[1] === 'const' ? 'constants' : 'variables';
			spans.push(makeSpan(spanIdx++, start + 1, i, 'narration',
				`Declares ${declKind}.`));
			continue;
		}

		// Comments: // or /* */
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

		i++;
	}

	return spans;
}

// ── Rust parser ──────────────────────────────────────────────────────

function parseRustSpans(lines: string[]): ReaderSpan[] {
	const spans: ReaderSpan[] = [];
	let spanIdx = 0;

	let i = 0;
	while (i < lines.length) {
		if (lines[i].trim() === '') {
			i++;
			continue;
		}

		// Use declarations: use crate::...; / use std::...;
		if (isRustUseLine(lines[i])) {
			const start = i;
			while (i < lines.length && (isRustUseLine(lines[i]) || lines[i].trim() === '')) {
				i++;
			}
			let end = i - 1;
			while (end > start && lines[end].trim() === '') {
				end--;
			}
			const count = countRustUses(lines, start, end);
			spans.push(makeSpan(spanIdx++, start + 1, end + 1, 'import',
				`Brings in ${count} ${count === 1 ? 'dependency' : 'dependencies'} this file needs.`));
			continue;
		}

		// Attribute lines: #[...] or #![...] — collect and attach to next item
		if (lines[i].trimStart().startsWith('#[') || lines[i].trimStart().startsWith('#![')) {
			const attrStart = i;
			while (i < lines.length && (lines[i].trimStart().startsWith('#[') || lines[i].trimStart().startsWith('#!['))) {
				i++;
			}
			// Fall through to let the next item pick up from attrStart
			if (i < lines.length) {
				const rustFn = matchRustFn(lines[i]);
				if (rustFn) {
					const end = findBlockEnd(lines, i);
					spans.push(makeSpan(spanIdx++, attrStart + 1, end + 1, 'action',
						`Defines ${rustFn.pub ? 'a public ' : ''}${rustFn.async ? 'async ' : ''}function "${rustFn.name}".`));
					i = end + 1;
					continue;
				}
			}
			continue;
		}

		// Function: [pub] [async] fn name(params) [-> ReturnType] {
		const rustFn = matchRustFn(lines[i]);
		if (rustFn) {
			const start = i;
			const end = findBlockEnd(lines, i);
			spans.push(makeSpan(spanIdx++, start + 1, end + 1, 'action',
				`Defines ${rustFn.pub ? 'a public ' : ''}${rustFn.async ? 'async ' : ''}function "${rustFn.name}".`));
			i = end + 1;
			continue;
		}

		// Struct: [pub] struct Name { ... }
		const rustStruct = lines[i].match(/^\s*(pub\s+)?struct\s+(\w+)/);
		if (rustStruct) {
			const start = i;
			const end = lines[i].includes(';') ? i : findBlockEnd(lines, i);
			spans.push(makeSpan(spanIdx++, start + 1, end + 1, 'declaration',
				`Defines ${rustStruct[1] ? 'a public ' : ''}struct "${rustStruct[2]}".`));
			i = end + 1;
			continue;
		}

		// Enum: [pub] enum Name { ... }
		const rustEnum = lines[i].match(/^\s*(pub\s+)?enum\s+(\w+)/);
		if (rustEnum) {
			const start = i;
			const end = findBlockEnd(lines, i);
			spans.push(makeSpan(spanIdx++, start + 1, end + 1, 'declaration',
				`Defines ${rustEnum[1] ? 'a public ' : ''}enum "${rustEnum[2]}".`));
			i = end + 1;
			continue;
		}

		// Trait: [pub] trait Name { ... }
		const rustTrait = lines[i].match(/^\s*(pub\s+)?trait\s+(\w+)/);
		if (rustTrait) {
			const start = i;
			const end = findBlockEnd(lines, i);
			spans.push(makeSpan(spanIdx++, start + 1, end + 1, 'declaration',
				`Defines ${rustTrait[1] ? 'a public ' : ''}trait "${rustTrait[2]}".`));
			i = end + 1;
			continue;
		}

		// Impl block: impl [Trait for] Type { ... }
		const rustImpl = lines[i].match(/^\s*impl(?:<[^>]*>)?\s+(?:(\w+)\s+for\s+)?(\w+)/);
		if (rustImpl) {
			const start = i;
			const end = findBlockEnd(lines, i);
			const traitName = rustImpl[1];
			const typeName = rustImpl[2];
			const desc = traitName
				? `Implements trait "${traitName}" for "${typeName}".`
				: `Implements methods for "${typeName}".`;
			spans.push(makeSpan(spanIdx++, start + 1, end + 1, 'declaration', desc));
			i = end + 1;
			continue;
		}

		// Mod declaration
		const rustMod = lines[i].match(/^\s*(pub\s+)?mod\s+(\w+)/);
		if (rustMod) {
			const start = i;
			if (lines[i].includes('{')) {
				const end = findBlockEnd(lines, i);
				spans.push(makeSpan(spanIdx++, start + 1, end + 1, 'declaration',
					`Defines ${rustMod[1] ? 'a public ' : ''}module "${rustMod[2]}".`));
				i = end + 1;
			} else {
				spans.push(makeSpan(spanIdx++, start + 1, start + 1, 'declaration',
					`Declares ${rustMod[1] ? 'a public ' : ''}module "${rustMod[2]}".`));
				i++;
			}
			continue;
		}

		// Comments: // or /// or /* */
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

		i++;
	}

	return spans;
}

function isRustUseLine(line: string): boolean {
	return /^\s*(pub\s+)?use\s+/.test(line);
}

function countRustUses(lines: string[], start: number, end: number): number {
	let count = 0;
	for (let i = start; i <= end; i++) {
		if (/^\s*(pub\s+)?use\s+/.test(lines[i])) {
			count++;
		}
	}
	return Math.max(count, 1);
}

interface RustFnMatch {
	name: string;
	pub: boolean;
	async: boolean;
}

function matchRustFn(line: string): RustFnMatch | null {
	const m = line.match(/^\s*(pub(?:\([\w:]+\))?\s+)?(async\s+)?(?:unsafe\s+)?fn\s+(\w+)/);
	return m ? { name: m[3], pub: !!m[1], async: !!m[2] } : null;
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

function isJsImportLine(line: string): boolean {
	const t = line.trimStart();
	return t.startsWith('import ') || t.startsWith('import{') ||
		t.startsWith('from ') ||
		(t.startsWith('const ') && t.includes('require(')) ||
		(t.startsWith('import('));
}

function countJsImports(lines: string[], start: number, end: number): number {
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
