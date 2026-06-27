/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { basename, dirname } from '../../../../base/common/path.js';
import { URI } from '../../../../base/common/uri.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import type { Connection, ConnectionRole } from './shilReaderTypes.js';

/**
 * Static connections scanner: analyses the current file's imports and
 * searches sibling/nearby files for reverse imports (who depends on this file).
 *
 * v1: regex-based, no tree-sitter. Handles TS/JS, Python, Go, and Rust imports.
 * Produces grounded Connection[] with "what breaks" reasoning.
 */

interface ImportInfo {
	/** The resolved module path (relative, e.g. './auth' or '../lib/db') */
	specifier: string;
	/** Named imports, e.g. ['getSession', 'requireAuth'] */
	names: string[];
	/** Whether this import is relative (local file) vs a package/module */
	isRelative: boolean;
}

// ── Language detection ────────────────────────────────────────────────

const JS_TS_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs)$/;
const PY_EXTENSIONS = /\.py$/;
const GO_EXTENSIONS = /\.go$/;
const RUST_EXTENSIONS = /\.rs$/;

function languageFromPath(path: string): string {
	if (JS_TS_EXTENSIONS.test(path)) { return 'javascript'; }
	if (PY_EXTENSIONS.test(path)) { return 'python'; }
	if (GO_EXTENSIONS.test(path)) { return 'go'; }
	if (RUST_EXTENSIONS.test(path)) { return 'rust'; }
	return 'unknown';
}

function isCodeFile(path: string): boolean {
	return /\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/.test(path);
}

// ── JS/TS import parser ──────────────────────────────────────────────

function parseJsTsImports(source: string): ImportInfo[] {
	const results: ImportInfo[] = [];
	const lines = source.split('\n');

	let i = 0;
	while (i < lines.length) {
		const line = lines[i].trim();

		// import { x, y } from './path'
		// import x from './path'
		// import * as x from './path'
		// import './path'
		const singleLine = line.match(/^import\s+(?:(?:type\s+)?(?:\{([^}]*)\}|(\w+)|\*\s+as\s+(\w+))(?:\s*,\s*(?:\{([^}]*)\}|\*\s+as\s+(\w+)))?\s+from\s+)?['"]([^'"]+)['"]/);
		if (singleLine) {
			const names: string[] = [];
			if (singleLine[1]) {
				names.push(...singleLine[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0]).filter(Boolean));
			}
			if (singleLine[2]) {
				names.push(singleLine[2]);
			}
			if (singleLine[3]) {
				names.push(singleLine[3]);
			}
			if (singleLine[4]) {
				names.push(...singleLine[4].split(',').map(n => n.trim().split(/\s+as\s+/)[0]).filter(Boolean));
			}
			const specifier = singleLine[6];
			results.push({ specifier, names, isRelative: specifier.startsWith('./') || specifier.startsWith('../') });
			i++;
			continue;
		}

		// Multi-line import: import {\n  x,\n  y\n} from './path'
		if (line.startsWith('import') && line.includes('{') && !line.includes('}')) {
			const importLines = [line];
			let j = i + 1;
			while (j < lines.length) {
				importLines.push(lines[j].trim());
				if (lines[j].includes('}')) {
					break;
				}
				j++;
			}
			const joined = importLines.join(' ');
			const multiMatch = joined.match(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/);
			if (multiMatch) {
				const names = multiMatch[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0]).filter(Boolean);
				const specifier = multiMatch[2];
				results.push({ specifier, names, isRelative: specifier.startsWith('./') || specifier.startsWith('../') });
			}
			i = j + 1;
			continue;
		}

		// require() calls
		const reqMatch = line.match(/(?:const|let|var)\s+(?:\{([^}]*)\}|(\w+))\s*=\s*require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
		if (reqMatch) {
			const names: string[] = [];
			if (reqMatch[1]) {
				names.push(...reqMatch[1].split(',').map(n => n.trim()).filter(Boolean));
			}
			if (reqMatch[2]) {
				names.push(reqMatch[2]);
			}
			const specifier = reqMatch[3];
			results.push({ specifier, names, isRelative: specifier.startsWith('./') || specifier.startsWith('../') });
		}

		i++;
	}

	return results;
}

// ── Python import parser ─────────────────────────────────────────────

function parsePythonImports(source: string): ImportInfo[] {
	const results: ImportInfo[] = [];
	const lines = source.split('\n');

	for (const line of lines) {
		const trimmed = line.trim();

		// from .module import name1, name2
		// from ..package.module import name
		const fromMatch = trimmed.match(/^from\s+(\.{1,3}[\w.]*)\s+import\s+(.+)/);
		if (fromMatch) {
			const specifier = fromMatch[1];
			const namesPart = fromMatch[2].split('#')[0].trim(); // strip comments
			const names = namesPart.split(',').map(n => {
				const parts = n.trim().split(/\s+as\s+/);
				return parts[0].trim();
			}).filter(Boolean);
			results.push({ specifier, names, isRelative: true });
			continue;
		}

		// from package import name (absolute — not relative)
		const fromAbsMatch = trimmed.match(/^from\s+([\w.]+)\s+import\s+(.+)/);
		if (fromAbsMatch) {
			const specifier = fromAbsMatch[1];
			const namesPart = fromAbsMatch[2].split('#')[0].trim();
			const names = namesPart.split(',').map(n => {
				const parts = n.trim().split(/\s+as\s+/);
				return parts[0].trim();
			}).filter(Boolean);
			results.push({ specifier, names, isRelative: false });
			continue;
		}

		// import module.submodule
		// import module as alias
		const importMatch = trimmed.match(/^import\s+([\w.]+)(?:\s+as\s+\w+)?/);
		if (importMatch) {
			const specifier = importMatch[1];
			const name = specifier.split('.').pop() || specifier;
			results.push({ specifier, names: [name], isRelative: false });
			continue;
		}
	}

	return results;
}

// ── Go import parser ─────────────────────────────────────────────────

function parseGoImports(source: string): ImportInfo[] {
	const results: ImportInfo[] = [];
	const lines = source.split('\n');

	let i = 0;
	while (i < lines.length) {
		const trimmed = lines[i].trim();

		// Single import: import "fmt" or import alias "pkg/path"
		const singleMatch = trimmed.match(/^import\s+(?:(\w+)\s+)?"([^"]+)"/);
		if (singleMatch) {
			const specifier = singleMatch[2];
			const alias = singleMatch[1] || specifier.split('/').pop() || specifier;
			results.push({ specifier, names: [alias], isRelative: isGoRelativeImport(specifier) });
			i++;
			continue;
		}

		// Multi-line import block: import (\n  "pkg1"\n  alias "pkg2"\n)
		if (trimmed === 'import (' || trimmed.startsWith('import (')) {
			i++;
			while (i < lines.length) {
				const blockLine = lines[i].trim();
				if (blockLine === ')' || blockLine.startsWith(')')) {
					break;
				}
				// Skip blank lines and comments
				if (blockLine === '' || blockLine.startsWith('//')) {
					i++;
					continue;
				}
				const pkgMatch = blockLine.match(/^(?:(\w+)\s+)?"([^"]+)"/);
				if (pkgMatch) {
					const specifier = pkgMatch[2];
					const alias = pkgMatch[1] || specifier.split('/').pop() || specifier;
					results.push({ specifier, names: [alias], isRelative: isGoRelativeImport(specifier) });
				}
				i++;
			}
			i++;
			continue;
		}

		i++;
	}

	return results;
}

function isGoRelativeImport(specifier: string): boolean {
	// Go uses module-relative imports like "./internal/auth" but this is uncommon.
	// More commonly, imports within the same module use the full module path.
	// We treat imports without a domain (no .) as potentially local.
	return specifier.startsWith('./') || specifier.startsWith('../') ||
		(!specifier.includes('.') && !specifier.startsWith('go/'));
}

// ── Rust import parser ───────────────────────────────────────────────

function parseRustImports(source: string): ImportInfo[] {
	const results: ImportInfo[] = [];
	const lines = source.split('\n');

	for (const line of lines) {
		const trimmed = line.trim();

		// use crate::module::Item;
		// use super::module::{Item1, Item2};
		// use self::child;
		// pub use ...
		const useMatch = trimmed.match(/^(?:pub\s+)?use\s+((?:crate|super|self)(?:::\w+)*)(?:::\{([^}]+)\})?(?:::(\w+))?/);
		if (useMatch) {
			const basePath = useMatch[1];
			const names: string[] = [];
			if (useMatch[2]) {
				// Braced imports: {Item1, Item2, self}
				names.push(...useMatch[2].split(',').map(n => {
					const parts = n.trim().split(/\s+as\s+/);
					return parts[0].trim();
				}).filter(n => n && n !== 'self'));
			}
			if (useMatch[3]) {
				names.push(useMatch[3]);
			}
			if (names.length === 0) {
				// use crate::module (imports the module itself)
				const lastSeg = basePath.split('::').pop();
				if (lastSeg) {
					names.push(lastSeg);
				}
			}
			const isRelative = basePath.startsWith('crate') || basePath.startsWith('super') || basePath.startsWith('self');
			results.push({ specifier: basePath, names, isRelative });
			continue;
		}

		// mod child_module;  (declares a submodule — a dependency)
		const modMatch = trimmed.match(/^(?:pub\s+)?mod\s+(\w+)\s*;/);
		if (modMatch) {
			results.push({
				specifier: `self::${modMatch[1]}`,
				names: [modMatch[1]],
				isRelative: true,
			});
			continue;
		}

		// External crate use: use serde::{Serialize, Deserialize};
		const extUseMatch = trimmed.match(/^(?:pub\s+)?use\s+(\w[\w_]*)(?:::\{([^}]+)\})?(?:::(\w+))?/);
		if (extUseMatch && !extUseMatch[1].match(/^(crate|super|self)$/)) {
			const specifier = extUseMatch[1];
			const names: string[] = [];
			if (extUseMatch[2]) {
				names.push(...extUseMatch[2].split(',').map(n => n.trim().split(/\s+as\s+/)[0]).filter(Boolean));
			}
			if (extUseMatch[3]) {
				names.push(extUseMatch[3]);
			}
			if (names.length === 0) {
				names.push(specifier);
			}
			results.push({ specifier, names, isRelative: false });
		}
	}

	return results;
}

// ── Unified import dispatcher ────────────────────────────────────────

/**
 * Parse imports from source code, dispatching to the right parser by language.
 */
export function parseImports(source: string, languageId?: string): ImportInfo[] {
	switch (languageId) {
		case 'python':
			return parsePythonImports(source);
		case 'go':
			return parseGoImports(source);
		case 'rust':
			return parseRustImports(source);
		default:
			return parseJsTsImports(source);
	}
}

// ── Path resolution ──────────────────────────────────────────────────

/**
 * Resolve a relative import specifier against the directory of the importing file.
 * Returns the normalized path without extension.
 */
function resolveRelativeImport(importerPath: string, specifier: string): string {
	const dir = dirname(importerPath);
	const parts = [...dir.split('/'), ...specifier.split('/')];
	const resolved: string[] = [];
	for (const p of parts) {
		if (p === '.' || p === '') {
			continue;
		} else if (p === '..') {
			resolved.pop();
		} else {
			resolved.push(p);
		}
	}
	let result = '/' + resolved.join('/');
	// Strip known extensions for matching
	result = result.replace(/\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs)$/, '');
	return result;
}

/**
 * Resolve a Python relative import (dot-based) to a file path.
 * e.g. ".auth" from "/app/routes/login.py" -> "/app/routes/auth"
 */
function resolvePythonImport(importerPath: string, specifier: string): string {
	const dir = dirname(importerPath);
	// Count leading dots
	const dotMatch = specifier.match(/^(\.+)(.*)/);
	if (!dotMatch) {
		return specifier; // absolute import, can't resolve to a path
	}
	const dots = dotMatch[1].length;
	const rest = dotMatch[2];

	let base = dir;
	// Each dot beyond the first goes up one directory
	for (let d = 1; d < dots; d++) {
		base = dirname(base);
	}

	if (rest) {
		// Convert dots in module path to slashes
		const segments = rest.split('.');
		return base + '/' + segments.join('/');
	}
	return base;
}

/**
 * Resolve a Rust import path (crate::, super::, self::) to a file path.
 */
function resolveRustImport(importerPath: string, specifier: string): string {
	const dir = dirname(importerPath);
	const parts = specifier.split('::');

	if (parts[0] === 'self') {
		// self::child -> same directory/child
		const rest = parts.slice(1);
		return dir + '/' + rest.join('/');
	}
	if (parts[0] === 'super') {
		// super::sibling -> parent directory/sibling
		let base = dirname(dir);
		let idx = 1;
		while (idx < parts.length && parts[idx] === 'super') {
			base = dirname(base);
			idx++;
		}
		const rest = parts.slice(idx);
		if (rest.length > 0) {
			return base + '/' + rest.join('/');
		}
		return base;
	}
	if (parts[0] === 'crate') {
		// crate:: imports are relative to the crate root — we approximate
		// by walking up from the current file to find src/lib.rs or src/main.rs
		// For now, just return a path relative to dirname that may match
		const rest = parts.slice(1);
		return dir + '/' + rest.join('/');
	}
	return specifier.replace(/::/g, '/');
}

// ── File existence resolution ────────────────────────────────────────

/**
 * Try to resolve a base path to an actual file by appending language-specific
 * extensions and checking for package index files (e.g. __init__.py, mod.rs).
 * Returns the first existing path, or the base path as a fallback.
 */
async function resolveToExistingFile(
	basePath: string,
	fileService: IFileService,
	lang: string,
): Promise<string> {
	// If the path already has a recognized extension, check it directly
	if (/\.\w+$/.test(basePath)) {
		try {
			if (await fileService.exists(URI.file(basePath))) {
				return basePath;
			}
		} catch { /* skip */ }
		return basePath;
	}

	// Language-specific extension candidates, ordered by likelihood
	const candidates: string[] = [];
	switch (lang) {
		case 'python':
			candidates.push('.py', '/__init__.py');
			break;
		case 'go':
			candidates.push('.go');
			break;
		case 'rust':
			candidates.push('.rs', '/mod.rs');
			break;
		default:
			candidates.push('.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '/index.ts', '/index.js');
			break;
	}

	for (const ext of candidates) {
		try {
			const uri = URI.file(basePath + ext);
			if (await fileService.exists(uri)) {
				return basePath + ext;
			}
		} catch { /* skip */ }
	}
	return basePath;
}

// ── Main scanner ─────────────────────────────────────────────────────

/**
 * Build connections for a file by:
 * 1. Parsing its imports -> "this file relies on" (role: imports)
 * 2. Scanning nearby files for reverse imports -> "these break if you change this" (role: calledBy)
 * 3. Detecting database patterns -> reads/writes connections
 */
export async function scanConnections(
	filePath: string,
	source: string,
	fileService: IFileService,
	languageId?: string,
): Promise<Connection[]> {
	const connections: Connection[] = [];
	let connIdx = 0;

	const lang = languageId || languageFromPath(filePath);
	const imports = parseImports(source, lang);

	// 1. Forward imports: what does this file depend on?
	for (const imp of imports) {
		if (!imp.isRelative) {
			// Skip external packages — they're stable contracts, not "what breaks"
			continue;
		}

		let resolvedPath: string;
		switch (lang) {
			case 'python':
				resolvedPath = resolvePythonImport(filePath, imp.specifier);
				break;
			case 'rust':
				resolvedPath = resolveRustImport(filePath, imp.specifier);
				break;
			default:
				resolvedPath = resolveRelativeImport(filePath, imp.specifier);
				break;
		}

		// Resolve to an actual file path (with correct extension)
		resolvedPath = await resolveToExistingFile(resolvedPath, fileService, lang);

		const namesList = imp.names.length > 0 ? imp.names.join(', ') : 'module';
		const displaySpecifier = imp.specifier.replace(/::/g, '/');
		connections.push({
			id: `conn-${connIdx++}`,
			title: basename(displaySpecifier) || displaySpecifier,
			path: resolvedPath,
			role: 'imports',
			breaks: `This file uses ${namesList} from ${imp.specifier}. If that module's API changes, this file breaks.`,
			symbols: imp.names,
		});
	}

	// 2. Reverse imports: scan sibling files for who imports this file
	const fileDir = dirname(filePath);
	const fileBaseName = basename(filePath).replace(/\.\w+$/, '');
	const reverseConnections = await scanReverseImports(filePath, fileDir, fileBaseName, fileService);
	for (const rev of reverseConnections) {
		rev.id = `conn-${connIdx++}`;
		connections.push(rev);
	}

	// 3. Database pattern detection: reads/writes
	const dbConnections = scanDatabasePatterns(source, lang);
	for (const db of dbConnections) {
		db.id = `conn-${connIdx++}`;
		connections.push(db);
	}

	return connections;
}

// ── Reverse import scanner ───────────────────────────────────────────

/**
 * Scan files in the same directory (and parent) for imports that reference the target file.
 * This produces "calledBy" connections: files that depend on the target and would break.
 */
async function scanReverseImports(
	targetPath: string,
	targetDir: string,
	targetBaseName: string,
	fileService: IFileService,
): Promise<Connection[]> {
	const connections: Connection[] = [];
	const dirsToScan = [targetDir];

	// Also scan parent directory
	const parentDir = dirname(targetDir);
	if (parentDir !== targetDir) {
		dirsToScan.push(parentDir);
	}

	// Normalize target path for matching (strip extension)
	const resolvedTarget = targetPath.replace(/\.\w+$/, '');

	for (const dir of dirsToScan) {
		try {
			const dirUri = URI.file(dir);
			const stat = await fileService.resolve(dirUri);
			if (!stat.children) {
				continue;
			}

			for (const child of stat.children) {
				if (child.isDirectory) {
					continue;
				}
				const childPath = child.resource.path;
				if (childPath === targetPath) {
					continue;
				}
				if (!isCodeFile(childPath)) {
					continue;
				}

				try {
					const content = await fileService.readFile(child.resource);
					const childSource = content.value.toString();
					const childLang = languageFromPath(childPath);
					const childImports = parseImports(childSource, childLang);

					for (const imp of childImports) {
						if (!imp.isRelative) {
							continue;
						}

						let resolved: string;
						switch (childLang) {
							case 'python':
								resolved = resolvePythonImport(childPath, imp.specifier);
								break;
							case 'rust':
								resolved = resolveRustImport(childPath, imp.specifier);
								break;
							default:
								resolved = resolveRelativeImport(childPath, imp.specifier);
								break;
						}

						if (resolved === resolvedTarget ||
							resolved === resolvedTarget + '/index' ||
							resolved === resolvedTarget + '/__init__' ||
							resolved === resolvedTarget + '/mod' ||
							basename(resolved) === targetBaseName) {
							const namesList = imp.names.length > 0 ? imp.names.join(', ') : 'this module';
							connections.push({
								id: '', // filled by caller
								title: basename(childPath),
								path: childPath,
								role: 'calledBy' as ConnectionRole,
								breaks: `${basename(childPath)} imports ${namesList}. Changing the exported API here will break it.`,
								symbols: imp.names,
							});
							break; // one match per file is enough
						}
					}
				} catch {
					// Skip unreadable files
				}
			}
		} catch {
			// Directory not readable
		}
	}

	return connections;
}

// ── Database pattern detection ───────────────────────────────────────

/**
 * Detect database read/write patterns in source code.
 * Recognizes ORM patterns for JS/TS (Prisma, Drizzle, Mongoose, Knex),
 * Python (SQLAlchemy, Django ORM), Go (GORM, sqlx), and Rust (Diesel, sqlx).
 */
function scanDatabasePatterns(source: string, lang: string): Connection[] {
	const connections: Connection[] = [];
	const seen = new Set<string>();

	const readPatterns: Array<{ pattern: RegExp; lib: string; desc: string }> = [
		// JS/TS ORMs
		{ pattern: /\bprisma\.(\w+)\.(findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|count|aggregate|groupBy)\b/g, lib: 'Prisma', desc: 'query' },
		{ pattern: /\bdb\.select\b/g, lib: 'Drizzle', desc: 'select query' },
		{ pattern: /\bdb\.query\.\w+\.(findMany|findFirst)\b/g, lib: 'Drizzle', desc: 'query' },
		{ pattern: /\.(?:find|findOne|findById|countDocuments|distinct|aggregate)\s*\(/g, lib: 'Mongoose', desc: 'query' },
		{ pattern: /\.select\s*\(/g, lib: 'SQL', desc: 'select' },
		{ pattern: /\bSELECT\b.*\bFROM\b/gi, lib: 'SQL', desc: 'SELECT query' },
	];

	const writePatterns: Array<{ pattern: RegExp; lib: string; desc: string }> = [
		{ pattern: /\bprisma\.(\w+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g, lib: 'Prisma', desc: 'mutation' },
		{ pattern: /\bdb\.(insert|update|delete)\b/g, lib: 'Drizzle', desc: 'mutation' },
		{ pattern: /\.(?:save|create|insertMany|updateOne|updateMany|deleteOne|deleteMany|replaceOne|bulkWrite)\s*\(/g, lib: 'Mongoose', desc: 'mutation' },
		{ pattern: /\.(?:insert|update|del|truncate)\s*\(/g, lib: 'SQL', desc: 'mutation' },
		{ pattern: /\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/gi, lib: 'SQL', desc: 'write query' },
	];

	// Add Python-specific patterns
	if (lang === 'python') {
		readPatterns.push(
			{ pattern: /\bsession\.query\b/g, lib: 'SQLAlchemy', desc: 'query' },
			{ pattern: /\bsession\.execute\b/g, lib: 'SQLAlchemy', desc: 'query' },
			{ pattern: /\.objects\.(?:filter|get|all|values|exclude|annotate|aggregate)\b/g, lib: 'Django', desc: 'query' },
			{ pattern: /\.objects\.(?:first|last|count|exists)\b/g, lib: 'Django', desc: 'query' },
		);
		writePatterns.push(
			{ pattern: /\bsession\.(?:add|add_all|delete|merge|flush|commit)\b/g, lib: 'SQLAlchemy', desc: 'mutation' },
			{ pattern: /\.objects\.(?:create|bulk_create|update|bulk_update|get_or_create|update_or_create)\b/g, lib: 'Django', desc: 'mutation' },
			{ pattern: /\.(?:save|delete)\s*\(/g, lib: 'Django', desc: 'mutation' },
		);
	}

	// Add Go-specific patterns
	if (lang === 'go') {
		readPatterns.push(
			{ pattern: /\.(?:Find|First|Last|Take|Where|Select|Scan|Row|Rows|QueryRow|Query)\s*\(/g, lib: 'GORM/SQL', desc: 'query' },
			{ pattern: /\bsqlx\.(?:Get|Select|NamedQuery)\b/g, lib: 'sqlx', desc: 'query' },
		);
		writePatterns.push(
			{ pattern: /\.(?:Create|Save|Update|Updates|Delete|Exec)\s*\(/g, lib: 'GORM/SQL', desc: 'mutation' },
			{ pattern: /\bsqlx\.(?:NamedExec|MustExec)\b/g, lib: 'sqlx', desc: 'mutation' },
		);
	}

	// Add Rust-specific patterns
	if (lang === 'rust') {
		readPatterns.push(
			{ pattern: /\.(?:load|first|get_result|get_results|filter|select)\s*[(<]/g, lib: 'Diesel', desc: 'query' },
			{ pattern: /sqlx::query(?:_as|_scalar)?\s*[!(]/g, lib: 'sqlx', desc: 'query' },
			{ pattern: /\.fetch_one|\.fetch_all|\.fetch_optional/g, lib: 'sqlx', desc: 'query' },
		);
		writePatterns.push(
			{ pattern: /diesel::(?:insert_into|update|delete)\b/g, lib: 'Diesel', desc: 'mutation' },
			{ pattern: /\.execute\s*\(/g, lib: 'Diesel/sqlx', desc: 'mutation' },
		);
	}

	for (const { pattern, lib, desc } of readPatterns) {
		let match;
		while ((match = pattern.exec(source)) !== null) {
			const key = `reads:${lib}:${match[0].substring(0, 40)}`;
			if (!seen.has(key)) {
				seen.add(key);
				const model = match[1] || '';
				const operation = match[2] || desc;
				const title = model ? `${lib}: ${model}` : `${lib} ${desc}`;
				connections.push({
					id: '',
					title,
					path: '',
					role: 'reads',
					breaks: `This file reads data via ${lib} ${operation}${model ? ` on "${model}"` : ''}. Other screens showing the same data may display stale values.`,
					symbols: model ? [model, operation] : [operation],
				});
			}
		}
	}

	for (const { pattern, lib, desc } of writePatterns) {
		let match;
		while ((match = pattern.exec(source)) !== null) {
			const key = `writes:${lib}:${match[0].substring(0, 40)}`;
			if (!seen.has(key)) {
				seen.add(key);
				const model = match[1] || '';
				const operation = match[2] || desc;
				const title = model ? `${lib}: ${model}` : `${lib} ${desc}`;
				connections.push({
					id: '',
					title,
					path: '',
					role: 'writes',
					breaks: `This file writes to the database via ${lib} ${operation}${model ? ` on "${model}"` : ''}. Changes here can corrupt or lose data.`,
					symbols: model ? [model, operation] : [operation],
				});
			}
		}
	}

	return connections;
}
