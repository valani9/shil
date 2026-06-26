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
 * 1. Parsing its imports → "this file relies on" (role: imports)
 * 2. Scanning nearby files for reverse imports → "these break if you change this" (role: calledBy)
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

	return connections;
}

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

function isCodeFile(path: string): boolean {
	return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(path);
}
