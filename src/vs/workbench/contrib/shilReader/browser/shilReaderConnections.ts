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
 * v0: regex-based, no tree-sitter. Handles TS/JS import statements.
 * Produces grounded Connection[] with "what breaks" reasoning.
 */

interface ImportInfo {
	/** The resolved module path (relative, e.g. './auth' or '../lib/db') */
	specifier: string;
	/** Named imports, e.g. ['getSession', 'requireAuth'] */
	names: string[];
}

/**
 * Parse import statements from source code.
 */
export function parseImports(source: string): ImportInfo[] {
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
			results.push({ specifier: singleLine[6], names });
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
				results.push({ specifier: multiMatch[2], names });
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
			results.push({ specifier: reqMatch[3], names });
		}

		i++;
	}

	return results;
}

/**
 * Check if a specifier is a relative path (not a node_module).
 */
function isRelativeImport(specifier: string): boolean {
	return specifier.startsWith('./') || specifier.startsWith('../');
}

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
	result = result.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
	return result;
}

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
): Promise<Connection[]> {
	const connections: Connection[] = [];
	let connIdx = 0;

	// 1. Forward imports: what does this file depend on?
	const imports = parseImports(source);
	for (const imp of imports) {
		if (!isRelativeImport(imp.specifier)) {
			// Skip node_modules — they're stable contracts, not "what breaks"
			continue;
		}
		const resolvedPath = resolveRelativeImport(filePath, imp.specifier);
		const namesList = imp.names.length > 0 ? imp.names.join(', ') : 'module';
		connections.push({
			id: `conn-${connIdx++}`,
			title: basename(imp.specifier),
			path: resolvedPath,
			role: 'imports',
			breaks: `This file uses ${namesList} from ${imp.specifier}. If that module's API changes, this file breaks.`,
			symbols: imp.names,
		});
	}

	// 2. Reverse imports: scan sibling files for who imports this file
	const fileDir = dirname(filePath);
	const fileBaseName = basename(filePath).replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');
	const reverseConnections = await scanReverseImports(filePath, fileDir, fileBaseName, fileService);
	for (const rev of reverseConnections) {
		rev.id = `conn-${connIdx++}`;
		connections.push(rev);
	}

	// 3. Database pattern detection: reads/writes
	const dbConnections = scanDatabasePatterns(source);
	for (const db of dbConnections) {
		db.id = `conn-${connIdx++}`;
		connections.push(db);
	}

	return connections;
}

/**
 * Scan files in the same directory (and parent) for imports that reference the target file.
 * This produces "calledBy" connections: files that depend on the target and would break.
 */
async function scanReverseImports(
	targetPath: string,
	targetDir: string,
	_targetBaseName: string,
	fileService: IFileService,
): Promise<Connection[]> {
	const connections: Connection[] = [];
	const dirsToScan = [targetDir];

	// Also scan parent directory
	const parentDir = dirname(targetDir);
	if (parentDir !== targetDir) {
		dirsToScan.push(parentDir);
	}

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
				// Skip self
				if (childPath === targetPath) {
					continue;
				}
				// Only scan code files
				if (!isCodeFile(childPath)) {
					continue;
				}

				try {
					const content = await fileService.readFile(child.resource);
					const childSource = content.value.toString();
					const childImports = parseImports(childSource);

					for (const imp of childImports) {
						if (!isRelativeImport(imp.specifier)) {
							continue;
						}
						const resolved = resolveRelativeImport(childPath, imp.specifier);
						const resolvedTarget = targetPath.replace(/\.(ts|tsx|js|jsx|mjs|cjs)$/, '');

						if (resolved === resolvedTarget || resolved === resolvedTarget + '/index') {
							const namesList = imp.names.length > 0 ? imp.names.join(', ') : 'this module';
							connections.push({
								id: '', // filled by caller
								title: basename(childPath),
								path: childPath,
								role: 'calledBy' as ConnectionRole,
								breaks: `${basename(childPath)} imports ${namesList}. Changing the exported API here will break it.`,
								symbols: imp.names,
							});
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

/**
 * Detect database read/write patterns in source code.
 * Recognizes Prisma, Drizzle, Sequelize, Mongoose, Knex, and raw SQL patterns.
 */
function scanDatabasePatterns(source: string): Connection[] {
	const connections: Connection[] = [];
	const seen = new Set<string>();

	const readPatterns: Array<{ pattern: RegExp; lib: string; desc: string }> = [
		// Prisma reads
		{ pattern: /\bprisma\.(\w+)\.(findMany|findFirst|findUnique|findUniqueOrThrow|findFirstOrThrow|count|aggregate|groupBy)\b/g, lib: 'Prisma', desc: 'query' },
		// Drizzle reads
		{ pattern: /\bdb\.select\b/g, lib: 'Drizzle', desc: 'select query' },
		{ pattern: /\bdb\.query\.\w+\.(findMany|findFirst)\b/g, lib: 'Drizzle', desc: 'query' },
		// Mongoose reads
		{ pattern: /\.(?:find|findOne|findById|countDocuments|distinct|aggregate)\s*\(/g, lib: 'Mongoose', desc: 'query' },
		// Knex/raw SQL reads
		{ pattern: /\.select\s*\(/g, lib: 'SQL', desc: 'select' },
		{ pattern: /\bSELECT\b.*\bFROM\b/gi, lib: 'SQL', desc: 'SELECT query' },
	];

	const writePatterns: Array<{ pattern: RegExp; lib: string; desc: string }> = [
		// Prisma writes
		{ pattern: /\bprisma\.(\w+)\.(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/g, lib: 'Prisma', desc: 'mutation' },
		// Drizzle writes
		{ pattern: /\bdb\.(insert|update|delete)\b/g, lib: 'Drizzle', desc: 'mutation' },
		// Mongoose writes
		{ pattern: /\.(?:save|create|insertMany|updateOne|updateMany|deleteOne|deleteMany|replaceOne|bulkWrite)\s*\(/g, lib: 'Mongoose', desc: 'mutation' },
		// Knex/raw SQL writes
		{ pattern: /\.(?:insert|update|del|truncate)\s*\(/g, lib: 'SQL', desc: 'mutation' },
		{ pattern: /\b(?:INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM)\b/gi, lib: 'SQL', desc: 'write query' },
	];

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

function isCodeFile(path: string): boolean {
	return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path);
}
