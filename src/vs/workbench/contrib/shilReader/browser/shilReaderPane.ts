/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/shilReader.css';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { ShilReaderInput, SHIL_READER_EDITOR_ID } from './shilReaderInput.js';
import { parseToReaderDoc } from './shilReaderParser.js';
import { scanConnections } from './shilReaderConnections.js';
import type { ReaderDoc, ReaderSpan, SpanKind, Connection, ConnectionRole } from './shilReaderTypes.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IRange } from '../../../../editor/common/core/range.js';
import { URI } from '../../../../base/common/uri.js';

export class ShilReaderPane extends EditorPane {

	static readonly ID = SHIL_READER_EDITOR_ID;

	private container: HTMLElement | undefined;
	private mainColumn: HTMLElement | undefined;
	private contentElement: HTMLElement | undefined;
	private railElement: HTMLElement | undefined;
	private currentDoc: ReaderDoc | undefined;
	private currentResource: URI | undefined;
	private readonly paneDisposables = this._register(new DisposableStore());

	/** Map from connection ID to its DOM element in the rail, for fast highlight toggling. */
	private readonly railItemElements = new Map<string, HTMLElement>();
	/** Currently highlighted connection IDs (for clearing on span leave). */
	private highlightedConnIds = new Set<string>();

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IEditorService private readonly editorService: IEditorService,
	) {
		super(ShilReaderPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = document.createElement('div');
		this.container.className = 'shil-reader-container';

		this.mainColumn = document.createElement('div');
		this.mainColumn.className = 'shil-reader-main';

		this.contentElement = document.createElement('div');
		this.contentElement.className = 'shil-reader-content';
		this.mainColumn.appendChild(this.contentElement);
		this.container.appendChild(this.mainColumn);

		this.railElement = document.createElement('aside');
		this.railElement.className = 'shil-reader-rail';
		this.container.appendChild(this.railElement);

		parent.appendChild(this.container);
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		if (!(input instanceof ShilReaderInput)) {
			return;
		}

		this.paneDisposables.clear();
		this.railItemElements.clear();
		this.highlightedConnIds.clear();

		this.currentResource = input.fileResource;

		try {
			const content = await this.fileService.readFile(input.fileResource);
			if (token.isCancellationRequested) {
				return;
			}

			const source = content.value.toString();
			const languageId = this.languageService.guessLanguageIdByFilepathOrFirstLine(input.fileResource) ?? 'plaintext';
			this.currentDoc = parseToReaderDoc(source, input.fileResource.path, languageId);
			this.renderDoc(this.currentDoc);

			// Scan connections in background (non-blocking)
			scanConnections(input.fileResource.path, source, this.fileService).then(connections => {
				if (token.isCancellationRequested) {
					return;
				}
				this.currentDoc!.connections = connections;
				this.renderRail(connections);
			});
		} catch {
			this.renderError();
		}
	}

	private renderDoc(doc: ReaderDoc): void {
		if (!this.contentElement) {
			return;
		}

		this.contentElement.textContent = '';

		// Header
		const header = document.createElement('header');
		header.className = 'shil-reader-header';
		header.innerHTML = `
			<div class="shil-reader-kicker">READER</div>
			<h1 class="shil-reader-title"></h1>
			<div class="shil-reader-meta"></div>
		`;
		(header.querySelector('.shil-reader-title') as HTMLElement).textContent = doc.title;
		(header.querySelector('.shil-reader-meta') as HTMLElement).textContent = `${doc.language} \u00B7 ${doc.spans.length} sections`;
		this.contentElement.appendChild(header);

		// Spans
		const spansContainer = document.createElement('div');
		spansContainer.className = 'shil-reader-spans';

		for (const span of doc.spans) {
			const spanEl = this.createSpanElement(span, doc);
			spansContainer.appendChild(spanEl);
		}

		this.contentElement.appendChild(spansContainer);
	}

	private createSpanElement(span: ReaderSpan, doc: ReaderDoc): HTMLElement {
		const el = document.createElement('div');
		el.className = `shil-reader-span shil-reader-span--${span.kind}`;
		el.dataset.spanId = span.id;

		// Kind badge
		const badge = document.createElement('span');
		badge.className = 'shil-reader-span-kind';
		badge.textContent = kindLabel(span.kind);
		el.appendChild(badge);

		// English prose
		const prose = document.createElement('p');
		prose.className = 'shil-reader-span-english';
		prose.textContent = span.english;
		el.appendChild(prose);

		// Line range reference (clickable -> jumps to code)
		const lineRef = document.createElement('span');
		lineRef.className = 'shil-reader-span-lines shil-reader-clickable';
		lineRef.textContent = span.lineStart === span.lineEnd
			? `line ${span.lineStart}`
			: `lines ${span.lineStart}\u2013${span.lineEnd}`;
		lineRef.title = 'Jump to this code';
		el.appendChild(lineRef);

		// Code excerpt (collapsed, first 3 lines)
		const sourceLines = doc.source.split('\n');
		const excerptLines = sourceLines.slice(span.lineStart - 1, Math.min(span.lineEnd, span.lineStart + 2));
		if (excerptLines.length > 0) {
			const code = document.createElement('pre');
			code.className = 'shil-reader-span-code shil-reader-clickable';
			code.title = 'Jump to this code';
			const codeInner = document.createElement('code');
			codeInner.textContent = excerptLines.join('\n') + (span.lineEnd - span.lineStart >= 3 ? '\n\u2026' : '');
			code.appendChild(codeInner);
			el.appendChild(code);
		}

		// Click-through: clicking anywhere on the span navigates to code
		el.addEventListener('click', () => this.navigateToCode(span));

		// Hover: highlight related connections in the rail
		el.addEventListener('mouseenter', () => this.highlightConnections(span, doc));
		el.addEventListener('mouseleave', () => this.clearHighlights());

		return el;
	}

	/**
	 * When hovering a span, highlight connections in the rail that relate to it.
	 * Matching logic:
	 * - Import spans highlight all "imports" role connections
	 * - Export/action/declaration spans highlight all "calledBy" connections
	 * - Any span: if its source code contains a symbol from a connection, highlight it
	 * - DB/action spans highlight reads/writes connections
	 */
	private highlightConnections(span: ReaderSpan, doc: ReaderDoc): void {
		this.clearHighlights();

		if (!this.currentDoc?.connections.length) {
			return;
		}

		// Extract the source text for this span
		const sourceLines = doc.source.split('\n');
		const spanSource = sourceLines.slice(span.lineStart - 1, span.lineEnd).join('\n');

		for (const conn of this.currentDoc.connections) {
			let matches = false;

			// Role-based matching
			if (span.kind === 'import' && conn.role === 'imports') {
				matches = true;
			} else if ((span.kind === 'export' || span.kind === 'action' || span.kind === 'declaration') && conn.role === 'calledBy') {
				matches = true;
			} else if ((span.kind === 'db' || span.kind === 'action') && (conn.role === 'reads' || conn.role === 'writes')) {
				matches = true;
			}

			// Symbol-based matching: check if any connection symbol appears in the span's code
			if (!matches && conn.symbols.length > 0) {
				for (const sym of conn.symbols) {
					if (sym.length >= 2 && spanSource.includes(sym)) {
						matches = true;
						break;
					}
				}
			}

			if (matches) {
				this.highlightedConnIds.add(conn.id);
				const el = this.railItemElements.get(conn.id);
				if (el) {
					el.classList.add('shil-rail-item--highlighted');
				}
			}
		}
	}

	private clearHighlights(): void {
		for (const connId of this.highlightedConnIds) {
			const el = this.railItemElements.get(connId);
			if (el) {
				el.classList.remove('shil-rail-item--highlighted');
			}
		}
		this.highlightedConnIds.clear();
	}

	private navigateToCode(span: ReaderSpan): void {
		if (!this.currentResource) {
			return;
		}
		const selection: IRange = {
			startLineNumber: span.lineStart,
			startColumn: 1,
			endLineNumber: span.lineEnd,
			endColumn: 1,
		};
		this.editorService.openEditor({
			resource: this.currentResource,
			options: {
				pinned: true,
				selection,
				revealIfOpened: true,
			}
		});
	}

	/**
	 * Open a connection's file in the editor. For connections with a valid
	 * file path, navigates to that file. For database/pattern connections
	 * (no path), this is a no-op.
	 */
	private navigateToConnection(conn: Connection): void {
		if (!conn.path) {
			return;
		}
		// Try the path as-is first, then with common extensions
		const extensions = ['', '.ts', '.tsx', '.js', '.jsx', '.mjs'];
		for (const ext of extensions) {
			const uri = URI.file(conn.path + ext);
			this.fileService.exists(uri).then(exists => {
				if (exists) {
					this.editorService.openEditor({
						resource: uri,
						options: { pinned: true, revealIfOpened: true },
					});
				}
			});
			// If the path already has an extension, only try the bare path
			if (/\.\w+$/.test(conn.path)) {
				break;
			}
		}
	}

	private renderError(): void {
		if (!this.contentElement) {
			return;
		}
		this.contentElement.textContent = '';
		const msg = document.createElement('div');
		msg.className = 'shil-reader-error';
		msg.textContent = 'Could not read this file.';
		this.contentElement.appendChild(msg);
	}

	private renderRail(connections: Connection[]): void {
		if (!this.railElement) {
			return;
		}
		this.railElement.textContent = '';
		this.railItemElements.clear();

		if (connections.length === 0) {
			const empty = document.createElement('div');
			empty.className = 'shil-rail-empty';
			empty.textContent = 'No connections found.';
			this.railElement.appendChild(empty);
			return;
		}

		// Group by role, ordered: calledBy -> reads -> writes -> imports
		const roleOrder: ConnectionRole[] = ['calledBy', 'reads', 'writes', 'imports'];
		const grouped = new Map<ConnectionRole, Connection[]>();
		for (const conn of connections) {
			const list = grouped.get(conn.role);
			if (list) {
				list.push(conn);
			} else {
				grouped.set(conn.role, [conn]);
			}
		}

		// Rail header
		const header = document.createElement('div');
		header.className = 'shil-rail-header';
		header.innerHTML = `<span class="shil-rail-kicker">WHAT BREAKS</span>`;
		this.railElement.appendChild(header);

		for (const role of roleOrder) {
			const conns = grouped.get(role);
			if (!conns || conns.length === 0) {
				continue;
			}

			const section = document.createElement('div');
			section.className = `shil-rail-section shil-rail-section--${role}`;

			const heading = document.createElement('div');
			heading.className = 'shil-rail-section-heading';
			heading.textContent = roleHeading(role);
			section.appendChild(heading);

			for (const conn of conns) {
				const item = document.createElement('div');
				item.className = `shil-rail-item shil-rail-item--${roleTone(role)}`;
				item.dataset.connId = conn.id;

				// Make items with file paths clickable
				if (conn.path) {
					item.classList.add('shil-rail-item--clickable');
					item.addEventListener('click', () => this.navigateToConnection(conn));
				}

				const title = document.createElement('div');
				title.className = 'shil-rail-item-title';
				title.textContent = conn.title;
				item.appendChild(title);

				const breaks = document.createElement('div');
				breaks.className = 'shil-rail-item-breaks';
				breaks.textContent = conn.breaks;
				item.appendChild(breaks);

				section.appendChild(item);

				// Store reference for fast highlight toggling
				this.railItemElements.set(conn.id, item);
			}

			this.railElement.appendChild(section);
		}
	}

	override clearInput(): void {
		super.clearInput();
		this.paneDisposables.clear();
		this.railItemElements.clear();
		this.highlightedConnIds.clear();
		this.currentDoc = undefined;
		this.currentResource = undefined;
		if (this.contentElement) {
			this.contentElement.textContent = '';
		}
		if (this.railElement) {
			this.railElement.textContent = '';
		}
	}

	override layout(dimension: Dimension): void {
		if (this.container) {
			this.container.style.width = `${dimension.width}px`;
			this.container.style.height = `${dimension.height}px`;
		}
	}

	override focus(): void {
		super.focus();
		this.contentElement?.focus();
	}
}

function kindLabel(kind: SpanKind): string {
	switch (kind) {
		case 'import': return 'IMPORTS';
		case 'guard': return 'GUARD';
		case 'action': return 'ACTION';
		case 'db': return 'DATABASE';
		case 'response': return 'RESPONSE';
		case 'narration': return 'NARRATIVE';
		case 'declaration': return 'DECLARATION';
		case 'export': return 'EXPORT';
	}
}

function roleHeading(role: ConnectionRole): string {
	switch (role) {
		case 'calledBy': return 'If you change this, these break';
		case 'reads': return 'Other screens reading the same data';
		case 'writes': return 'Writes to your database';
		case 'imports': return 'This file relies on';
	}
}

function roleTone(role: ConnectionRole): string {
	switch (role) {
		case 'calledBy': return 'breaks';
		case 'reads': return 'breaks';
		case 'writes': return 'data';
		case 'imports': return 'safe';
	}
}
