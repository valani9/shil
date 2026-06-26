/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The shape of a "reader document": one source file, its grounded
 * plain-English mapping, and its real connections.
 *
 * GROUNDING RULE: every `english` sentence describes only what the
 * code at [lineStart, lineEnd] actually does.
 */

export type SpanKind =
	| 'narration'
	| 'import'
	| 'guard'
	| 'action'
	| 'db'
	| 'response'
	| 'declaration'
	| 'export';

export interface ReaderSpan {
	id: string;
	/** Plain-English, grounded in the real code at the line range below. */
	english: string;
	/** 1-based inclusive source line range this sentence explains. */
	lineStart: number;
	lineEnd: number;
	kind: SpanKind;
}

export type ConnectionRole = 'imports' | 'calledBy' | 'reads' | 'writes';

export interface Connection {
	id: string;
	title: string;
	path: string;
	role: ConnectionRole;
	breaks: string;
}

export interface ReaderDoc {
	title: string;
	path: string;
	language: string;
	source: string;
	spans: ReaderSpan[];
	connections: Connection[];
}
