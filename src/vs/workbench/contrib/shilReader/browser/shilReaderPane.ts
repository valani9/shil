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
	/** Ordered span elements for keyboard navigation. */
	private spanElements: HTMLElement[] = [];
	/** Currently keyboard-focused span index (-1 = none). */
	private focusedSpanIdx = -1;
	/** Whether all spans are currently collapsed. */
	private allCollapsed = false;
	/** Whether focus mode is active (only focused span expanded). */
	private focusModeActive = false;
	/** Current active kind filter (null = show all). */
	private activeKindFilter: SpanKind | null = null;
	/** Current search text filter. */
	private searchFilter = '';

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
		this.contentElement.tabIndex = 0;
		this.contentElement.addEventListener('keydown', (e) => this.handleKeydown(e));
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
		this.allCollapsed = false;
		this.focusModeActive = false;
		this.activeKindFilter = null;
		this.searchFilter = '';

		// Header
		const header = document.createElement('header');
		header.className = 'shil-reader-header';

		const kicker = document.createElement('div');
		kicker.className = 'shil-reader-kicker';
		kicker.textContent = 'READER';
		header.appendChild(kicker);

		const title = document.createElement('h1');
		title.className = 'shil-reader-title';
		title.textContent = doc.title;
		header.appendChild(title);

		// Meta line: language + kind counts
		const meta = document.createElement('div');
		meta.className = 'shil-reader-meta';
		meta.textContent = this.buildMetaText(doc);
		header.appendChild(meta);

		// Header controls row: collapse-all + focus-mode toggles
		const controls = document.createElement('div');
		controls.className = 'shil-reader-controls';

		const collapseBtn = document.createElement('button');
		collapseBtn.className = 'shil-reader-control-btn';
		collapseBtn.textContent = 'Collapse All';
		collapseBtn.title = 'Collapse or expand all spans';
		collapseBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.toggleCollapseAll(collapseBtn);
		});
		controls.appendChild(collapseBtn);

		const focusBtn = document.createElement('button');
		focusBtn.className = 'shil-reader-control-btn';
		focusBtn.textContent = 'Focus Mode';
		focusBtn.title = 'Only the focused span stays expanded (shortcut: f)';
		focusBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			this.toggleFocusMode(focusBtn);
		});
		controls.appendChild(focusBtn);

		header.appendChild(controls);

		// Search / filter bar
		const filterBar = document.createElement('div');
		filterBar.className = 'shil-reader-filter-bar';

		const searchInput = document.createElement('input');
		searchInput.className = 'shil-reader-search';
		searchInput.type = 'text';
		searchInput.placeholder = 'Search spans\u2026';
		searchInput.setAttribute('aria-label', 'Search spans by text');
		searchInput.addEventListener('input', () => {
			this.searchFilter = searchInput.value.toLowerCase();
			this.applyFilters();
		});
		// Prevent keyboard nav from stealing search keystrokes; Escape returns focus to content
		searchInput.addEventListener('keydown', (e) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				searchInput.blur();
				this.contentElement?.focus();
				return;
			}
			e.stopPropagation();
		});
		filterBar.appendChild(searchInput);

		// Kind filter pills
		const kindPills = document.createElement('div');
		kindPills.className = 'shil-reader-kind-pills';
		const allKinds: SpanKind[] = ['import', 'guard', 'action', 'db', 'response', 'declaration', 'export'];
		// Only show pills for kinds that exist in this document
		const presentKinds = new Set(doc.spans.map(s => s.kind));
		for (const k of allKinds) {
			if (!presentKinds.has(k)) {
				continue;
			}
			const pill = document.createElement('button');
			pill.className = `shil-reader-kind-pill shil-reader-kind-pill--${k}`;
			pill.textContent = kindLabel(k);
			pill.dataset.kind = k;
			pill.addEventListener('click', (e) => {
				e.stopPropagation();
				if (this.activeKindFilter === k) {
					this.activeKindFilter = null;
					pill.classList.remove('shil-reader-kind-pill--active');
				} else {
					// Deactivate previous
					const prev = kindPills.querySelector('.shil-reader-kind-pill--active');
					if (prev) {
						prev.classList.remove('shil-reader-kind-pill--active');
					}
					this.activeKindFilter = k;
					pill.classList.add('shil-reader-kind-pill--active');
				}
				this.applyFilters();
			});
			kindPills.appendChild(pill);
		}
		filterBar.appendChild(kindPills);
		header.appendChild(filterBar);

		this.contentElement.appendChild(header);

		// Spans
		const spansContainer = document.createElement('div');
		spansContainer.className = 'shil-reader-spans';
		this.spanElements = [];
		this.focusedSpanIdx = -1;

		for (const span of doc.spans) {
			const spanEl = this.createSpanElement(span, doc);
			spansContainer.appendChild(spanEl);
			this.spanElements.push(spanEl);
		}

		this.contentElement.appendChild(spansContainer);
	}

	private createSpanElement(span: ReaderSpan, doc: ReaderDoc): HTMLElement {
		const el = document.createElement('div');
		el.className = `shil-reader-span shil-reader-span--${span.kind}`;
		el.dataset.spanId = span.id;

		// Top row: badge + chevron toggle
		const topRow = document.createElement('div');
		topRow.className = 'shil-reader-span-top';

		const badge = document.createElement('span');
		badge.className = 'shil-reader-span-kind';
		badge.textContent = kindLabel(span.kind);
		topRow.appendChild(badge);

		// Collapse/expand chevron
		const chevron = document.createElement('span');
		chevron.className = 'shil-reader-span-chevron';
		chevron.textContent = '\u25BE'; // ▾ down = expanded
		chevron.title = 'Collapse/expand';
		chevron.addEventListener('click', (e) => {
			e.stopPropagation();
			const collapsed = el.classList.toggle('shil-reader-span--collapsed');
			chevron.textContent = collapsed ? '\u25B8' : '\u25BE'; // ▸ right / ▾ down
		});
		topRow.appendChild(chevron);

		el.appendChild(topRow);

		// English prose
		const prose = document.createElement('p');
		prose.className = 'shil-reader-span-english';
		prose.textContent = span.english;
		el.appendChild(prose);

		// Collapsible detail container (line ref + code excerpt)
		const detail = document.createElement('div');
		detail.className = 'shil-reader-span-detail';

		// Line range reference
		const lineRef = document.createElement('span');
		lineRef.className = 'shil-reader-span-lines shil-reader-clickable';
		lineRef.textContent = span.lineStart === span.lineEnd
			? `line ${span.lineStart}`
			: `lines ${span.lineStart}\u2013${span.lineEnd}`;
		lineRef.title = 'Jump to this code';
		detail.appendChild(lineRef);

		// Full code excerpt with line numbers
		const sourceLines = doc.source.split('\n');
		const excerptLines = sourceLines.slice(span.lineStart - 1, span.lineEnd);
		if (excerptLines.length > 0) {
			const code = document.createElement('pre');
			code.className = 'shil-reader-span-code shil-reader-clickable';
			code.title = 'Jump to this code';

			const table = document.createElement('table');
			table.className = 'shil-reader-code-table';
			table.setAttribute('role', 'presentation');
			const tbody = document.createElement('tbody');

			for (let i = 0; i < excerptLines.length; i++) {
				const tr = document.createElement('tr');
				const gutterTd = document.createElement('td');
				gutterTd.className = 'shil-reader-code-gutter';
				gutterTd.textContent = String(span.lineStart + i);
				tr.appendChild(gutterTd);

				const lineTd = document.createElement('td');
				lineTd.className = 'shil-reader-code-line';
				lineTd.innerHTML = highlightSyntax(excerptLines[i]);
				tr.appendChild(lineTd);

				tbody.appendChild(tr);
			}

			table.appendChild(tbody);
			code.appendChild(table);
			detail.appendChild(code);
		}

		el.appendChild(detail);

		// Click-through: clicking anywhere on the span (except chevron) navigates to code
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

	/**
	 * Keyboard navigation: j/k to move between spans, Enter to jump to code,
	 * c to collapse/expand the focused span, Escape to clear focus.
	 */
	private handleKeydown(e: KeyboardEvent): void {
		if (e.key === 'j' || e.key === 'ArrowDown') {
			e.preventDefault();
			this.moveFocus(1);
		} else if (e.key === 'k' || e.key === 'ArrowUp') {
			e.preventDefault();
			this.moveFocus(-1);
		} else if (e.key === 'Enter' && this.focusedSpanIdx >= 0 && this.currentDoc) {
			e.preventDefault();
			this.navigateToCode(this.currentDoc.spans[this.focusedSpanIdx]);
		} else if (e.key === 'c' && this.focusedSpanIdx >= 0) {
			e.preventDefault();
			this.toggleSpanCollapse(this.spanElements[this.focusedSpanIdx]);
		} else if (e.key === 'f') {
			e.preventDefault();
			const btn = this.contentElement?.querySelector('.shil-reader-control-btn:nth-child(2)') as HTMLButtonElement | null;
			this.toggleFocusMode(btn);
		} else if (e.key === '/') {
			e.preventDefault();
			const search = this.contentElement?.querySelector('.shil-reader-search') as HTMLInputElement | null;
			if (search) {
				search.focus();
			}
		} else if (e.key === 'Escape') {
			this.clearSpanFocus();
		}
	}

	private moveFocus(delta: number): void {
		if (this.spanElements.length === 0) {
			return;
		}

		// Clear previous focus
		if (this.focusedSpanIdx >= 0 && this.focusedSpanIdx < this.spanElements.length) {
			this.spanElements[this.focusedSpanIdx].classList.remove('shil-reader-span--focused');
		}

		// Compute new index
		if (this.focusedSpanIdx < 0) {
			this.focusedSpanIdx = delta > 0 ? 0 : this.spanElements.length - 1;
		} else {
			this.focusedSpanIdx = Math.max(0, Math.min(this.spanElements.length - 1, this.focusedSpanIdx + delta));
		}

		// Apply focus
		const el = this.spanElements[this.focusedSpanIdx];
		el.classList.add('shil-reader-span--focused');
		el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });

		// Focus mode: collapse all others, expand the focused span
		if (this.focusModeActive) {
			this.applyFocusModeToSpan(this.focusedSpanIdx);
		}

		// Also highlight connections for the focused span
		if (this.currentDoc) {
			this.highlightConnections(this.currentDoc.spans[this.focusedSpanIdx], this.currentDoc);
		}
	}

	private clearSpanFocus(): void {
		if (this.focusedSpanIdx >= 0 && this.focusedSpanIdx < this.spanElements.length) {
			this.spanElements[this.focusedSpanIdx].classList.remove('shil-reader-span--focused');
		}
		this.focusedSpanIdx = -1;
		this.clearHighlights();
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

	/** Build the meta text with language, total sections, and per-kind counts. */
	private buildMetaText(doc: ReaderDoc): string {
		const counts = new Map<SpanKind, number>();
		for (const span of doc.spans) {
			counts.set(span.kind, (counts.get(span.kind) || 0) + 1);
		}
		// Only show kinds with counts, in a meaningful order
		const order: SpanKind[] = ['import', 'guard', 'action', 'db', 'response', 'declaration', 'export', 'narration'];
		const parts: string[] = [];
		for (const k of order) {
			const c = counts.get(k);
			if (c) {
				parts.push(`${c} ${kindLabel(k).toLowerCase()}`);
			}
		}
		const kindSummary = parts.length > 0 ? ` \u00B7 ${parts.join(', ')}` : '';
		return `${doc.language} \u00B7 ${doc.spans.length} sections${kindSummary}`;
	}

	/** Toggle collapse/expand for a single span element. */
	private toggleSpanCollapse(el: HTMLElement): void {
		const collapsed = el.classList.toggle('shil-reader-span--collapsed');
		const chevron = el.querySelector('.shil-reader-span-chevron');
		if (chevron) {
			chevron.textContent = collapsed ? '\u25B8' : '\u25BE';
		}
	}

	/** Collapse or expand all spans. */
	private toggleCollapseAll(btn: HTMLButtonElement | null): void {
		this.allCollapsed = !this.allCollapsed;
		for (const el of this.spanElements) {
			if (this.allCollapsed) {
				el.classList.add('shil-reader-span--collapsed');
			} else {
				el.classList.remove('shil-reader-span--collapsed');
			}
			const chevron = el.querySelector('.shil-reader-span-chevron');
			if (chevron) {
				chevron.textContent = this.allCollapsed ? '\u25B8' : '\u25BE';
			}
		}
		if (btn) {
			btn.textContent = this.allCollapsed ? 'Expand All' : 'Collapse All';
		}
	}

	/** Toggle focus mode: when active, only the focused span stays expanded. */
	private toggleFocusMode(btn: HTMLButtonElement | null): void {
		this.focusModeActive = !this.focusModeActive;
		if (btn) {
			btn.classList.toggle('shil-reader-control-btn--active', this.focusModeActive);
		}
		if (this.focusModeActive && this.focusedSpanIdx >= 0) {
			this.applyFocusModeToSpan(this.focusedSpanIdx);
		} else if (!this.focusModeActive) {
			// Exiting focus mode: expand all spans
			for (const el of this.spanElements) {
				el.classList.remove('shil-reader-span--collapsed');
				const chevron = el.querySelector('.shil-reader-span-chevron');
				if (chevron) {
					chevron.textContent = '\u25BE';
				}
			}
			this.allCollapsed = false;
			const collapseBtn = this.contentElement?.querySelector('.shil-reader-control-btn:first-child') as HTMLButtonElement | null;
			if (collapseBtn) {
				collapseBtn.textContent = 'Collapse All';
			}
		}
	}

	/** In focus mode, collapse all spans except the one at the given index. */
	private applyFocusModeToSpan(activeIdx: number): void {
		for (let i = 0; i < this.spanElements.length; i++) {
			const el = this.spanElements[i];
			const shouldCollapse = i !== activeIdx;
			if (shouldCollapse) {
				el.classList.add('shil-reader-span--collapsed');
			} else {
				el.classList.remove('shil-reader-span--collapsed');
			}
			const chevron = el.querySelector('.shil-reader-span-chevron');
			if (chevron) {
				chevron.textContent = shouldCollapse ? '\u25B8' : '\u25BE';
			}
		}
	}

	/** Apply kind + text search filters to show/hide spans. */
	private applyFilters(): void {
		if (!this.currentDoc) {
			return;
		}
		for (let i = 0; i < this.spanElements.length; i++) {
			const span = this.currentDoc.spans[i];
			const el = this.spanElements[i];
			let visible = true;

			if (this.activeKindFilter && span.kind !== this.activeKindFilter) {
				visible = false;
			}

			if (visible && this.searchFilter) {
				const haystack = span.english.toLowerCase();
				if (!haystack.includes(this.searchFilter)) {
					visible = false;
				}
			}

			el.style.display = visible ? '' : 'none';
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
		this.spanElements = [];
		this.focusedSpanIdx = -1;
		this.allCollapsed = false;
		this.focusModeActive = false;
		this.activeKindFilter = null;
		this.searchFilter = '';
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

/**
 * Simple regex-based syntax highlighter matching Shil Dark token colors.
 * Tokenizes a single line into spans for: comments, strings, keywords,
 * numbers, types, and punctuation. Returns safe HTML.
 */
function highlightSyntax(line: string): string {
	// We tokenize left-to-right, emitting spans for recognized tokens
	// and escaped plain text for the rest.
	const result: string[] = [];
	let pos = 0;

	while (pos < line.length) {
		// 1. Line comment (//)
		if (line[pos] === '/' && line[pos + 1] === '/') {
			result.push(`<span class="shil-hl-comment">${esc(line.slice(pos))}</span>`);
			pos = line.length;
			continue;
		}

		// 2. Block comment start (/* ... — may not close on this line)
		if (line[pos] === '/' && line[pos + 1] === '*') {
			const end = line.indexOf('*/', pos + 2);
			if (end >= 0) {
				result.push(`<span class="shil-hl-comment">${esc(line.slice(pos, end + 2))}</span>`);
				pos = end + 2;
			} else {
				result.push(`<span class="shil-hl-comment">${esc(line.slice(pos))}</span>`);
				pos = line.length;
			}
			continue;
		}

		// 3. Strings: single-quote, double-quote
		if (line[pos] === "'" || line[pos] === '"') {
			const quote = line[pos];
			let end = pos + 1;
			while (end < line.length) {
				if (line[end] === '\\') {
					end += 2; // skip escaped char
					continue;
				}
				if (line[end] === quote) {
					end++;
					break;
				}
				end++;
			}
			result.push(`<span class="shil-hl-string">${esc(line.slice(pos, end))}</span>`);
			pos = end;
			continue;
		}

		// 3b. Template literals with interpolation ${...} support
		if (line[pos] === '`') {
			result.push(`<span class="shil-hl-string">${esc('`')}</span>`);
			pos++;
			while (pos < line.length) {
				if (line[pos] === '\\') {
					result.push(`<span class="shil-hl-string">${esc(line.slice(pos, pos + 2))}</span>`);
					pos += 2;
					continue;
				}
				if (line[pos] === '`') {
					result.push(`<span class="shil-hl-string">${esc('`')}</span>`);
					pos++;
					break;
				}
				if (line[pos] === '$' && pos + 1 < line.length && line[pos + 1] === '{') {
					// Interpolation delimiter ${
					result.push('<span class="shil-hl-interp">${</span>');
					pos += 2;
					// Find matching } accounting for nested braces and strings
					let braceDepth = 1;
					const exprStart = pos;
					while (pos < line.length && braceDepth > 0) {
						if (line[pos] === "'" || line[pos] === '"' || line[pos] === '`') {
							const q = line[pos];
							pos++;
							while (pos < line.length && line[pos] !== q) {
								if (line[pos] === '\\') {
									pos++;
								}
								pos++;
							}
							if (pos < line.length) {
								pos++; // skip closing quote
							}
							continue;
						}
						if (line[pos] === '{') {
							braceDepth++;
						} else if (line[pos] === '}') {
							braceDepth--;
							if (braceDepth === 0) {
								break;
							}
						}
						pos++;
					}
					// Tokenize the expression between ${ and }
					const expr = line.slice(exprStart, pos);
					result.push(highlightSyntax(expr));
					// Closing } delimiter
					if (pos < line.length && line[pos] === '}') {
						result.push('<span class="shil-hl-interp">}</span>');
						pos++;
					}
					continue;
				}
				// Regular template literal content
				result.push(`<span class="shil-hl-string">${esc(line[pos])}</span>`);
				pos++;
			}
			continue;
		}

		// 4. Regex literals (/pattern/flags) — must distinguish from division
		if (line[pos] === '/' && pos + 1 < line.length && line[pos + 1] !== '/' && line[pos + 1] !== '*') {
			// A / is a regex if preceded by: start of line, =, (, [, {, ,, ;, !, &, |, ?, :, return, typeof, case, or other operator context
			const before = line.slice(0, pos).trimEnd();
			const isRegex = before.length === 0 ||
				/[=([{,;!&|?:+\-*%^~<>]$/.test(before) ||
				/\b(?:return|typeof|case|in|of|instanceof|new|delete|void|throw|yield)\s*$/.test(before);
			if (isRegex) {
				let end = pos + 1;
				let inClass = false; // inside character class []
				while (end < line.length) {
					if (line[end] === '\\') {
						end += 2; // skip escaped char
						continue;
					}
					if (line[end] === '[') {
						inClass = true;
					} else if (line[end] === ']') {
						inClass = false;
					} else if (line[end] === '/' && !inClass) {
						end++;
						break;
					}
					end++;
				}
				// Consume flags (g, i, m, s, u, v, y, d)
				while (end < line.length && /[gimsuvyd]/.test(line[end])) {
					end++;
				}
				result.push(`<span class="shil-hl-regex">${esc(line.slice(pos, end))}</span>`);
				pos = end;
				continue;
			}
		}

		// 5. Numbers (decimal, hex, binary, octal, scientific)
		const numMatch = line.slice(pos).match(/^(?:0[xXbBoO][\da-fA-F_]+|[\d][\d_]*(?:\.[\d_]*)?(?:[eE][+-]?\d+)?n?)\b/);
		if (numMatch && (pos === 0 || /[\s(,=[{;:+\-*/%<>!&|?~^]/.test(line[pos - 1]))) {
			result.push(`<span class="shil-hl-number">${esc(numMatch[0])}</span>`);
			pos += numMatch[0].length;
			continue;
		}

		// 6. Words: keywords, types, function calls, or plain identifiers
		const wordMatch = line.slice(pos).match(/^[a-zA-Z_$][\w$]*/);
		if (wordMatch) {
			const word = wordMatch[0];
			const cls = tokenClass(word);
			if (cls) {
				result.push(`<span class="${cls}">${esc(word)}</span>`);
				// 6a. Destructuring: const/let/var followed by { or [
				if ((word === 'const' || word === 'let' || word === 'var')) {
					const afterKw = line.slice(pos + word.length);
					const dsMatch = afterKw.match(/^(\s*)([{[])/);
					if (dsMatch) {
						// Emit whitespace before the bracket
						result.push(dsMatch[1]);
						pos += word.length + dsMatch[0].length;
						const closeBracket = dsMatch[2] === '{' ? '}' : ']';
						result.push(`<span class="shil-hl-punct">${esc(dsMatch[2])}</span>`);
						// Tokenize inside the destructuring pattern
						while (pos < line.length && line[pos] !== closeBracket) {
							// Skip whitespace
							if (/\s/.test(line[pos])) {
								result.push(line[pos]);
								pos++;
								continue;
							}
							// Nested destructuring
							if (line[pos] === '{' || line[pos] === '[') {
								result.push(`<span class="shil-hl-punct">${esc(line[pos])}</span>`);
								pos++;
								continue;
							}
							if (line[pos] === '}' || line[pos] === ']') {
								result.push(`<span class="shil-hl-punct">${esc(line[pos])}</span>`);
								pos++;
								continue;
							}
							// Commas, colons (rename), spread, rest
							if (line[pos] === ',' || line[pos] === ':' || line[pos] === '=') {
								result.push(`<span class="shil-hl-punct">${esc(line[pos])}</span>`);
								pos++;
								continue;
							}
							// Spread/rest operator
							if (line[pos] === '.' && line[pos + 1] === '.' && line[pos + 2] === '.') {
								result.push(`<span class="shil-hl-punct">...</span>`);
								pos += 3;
								continue;
							}
							// Variable names in destructuring
							const varMatch = line.slice(pos).match(/^[a-zA-Z_$][\w$]*/);
							if (varMatch) {
								const varName = varMatch[0];
								// After the name, check if followed by : (rename) — if so, this is the source key
								const afterVar = line.slice(pos + varName.length);
								const isKey = /^\s*:/.test(afterVar);
								if (isKey) {
									// Source key: use prop color
									result.push(`<span class="shil-hl-prop">${esc(varName)}</span>`);
								} else {
									// Destructured binding: use a distinct color (lime for emphasis)
									result.push(`<span class="shil-hl-destr">${esc(varName)}</span>`);
								}
								pos += varName.length;
								continue;
							}
							// Numbers (array destructuring with defaults)
							const numM = line.slice(pos).match(/^[\d]+/);
							if (numM) {
								result.push(`<span class="shil-hl-number">${esc(numM[0])}</span>`);
								pos += numM[0].length;
								continue;
							}
							// Strings in defaults
							if (line[pos] === "'" || line[pos] === '"') {
								const q = line[pos];
								let end = pos + 1;
								while (end < line.length && line[end] !== q) {
									if (line[end] === '\\') { end++; }
									end++;
								}
								if (end < line.length) { end++; }
								result.push(`<span class="shil-hl-string">${esc(line.slice(pos, end))}</span>`);
								pos = end;
								continue;
							}
							// Anything else
							result.push(esc(line[pos]));
							pos++;
						}
						// Closing bracket
						if (pos < line.length && line[pos] === closeBracket) {
							result.push(`<span class="shil-hl-punct">${esc(closeBracket)}</span>`);
							pos++;
						}
						continue;
					}
				}
			} else {
				// Check if this is a function call: word followed by (
				const afterWord = pos + word.length;
				const restAfter = line.slice(afterWord);
				const isFnCall = /^\s*\(/.test(restAfter);
				// Check if preceded by . — property access or method call
				const isProp = pos > 0 && line[pos - 1] === '.';
				if (isFnCall) {
					result.push(`<span class="shil-hl-fn">${esc(word)}</span>`);
				} else if (isProp) {
					result.push(`<span class="shil-hl-prop">${esc(word)}</span>`);
				} else {
					result.push(esc(word));
				}
			}
			pos += word.length;

			// 6b. Type annotation: word followed by `: TypeName`
			// Only fires when the type name is recognizable (TS primitives, PascalCase, builtin types)
			// to avoid false positives on object literal values like { key: value }
			const typeAnnotMatch = line.slice(pos).match(/^(\s*:\s*)([a-zA-Z_$][\w$]*(?:\s*\.\s*[a-zA-Z_$][\w$]*)*(?:\s*<[^>]*>)?(?:\s*\[\s*\])*(?:\s*\|\s*[a-zA-Z_$][\w$]*(?:\s*\.\s*[a-zA-Z_$][\w$]*)*(?:\s*<[^>]*>)?(?:\s*\[\s*\])*)*)/);
			if (typeAnnotMatch) {
				const typeExpr = typeAnnotMatch[2];
				// Extract the first type name (before any <, [, |, or .)
				const firstTypeName = typeExpr.match(/^[a-zA-Z_$][\w$]*/)?.[0] ?? '';
				if (isTypeName(firstTypeName)) {
					const colonAndSpace = typeAnnotMatch[1];
					result.push(`<span class="shil-hl-punct">${esc(colonAndSpace)}</span>`);
					result.push(`<span class="shil-hl-type">${esc(typeExpr)}</span>`);
					pos += typeAnnotMatch[0].length;
				}
			}

			continue;
		}

		// 7. JSX/TSX tags: <Component, </div>, or self-closing <br />
		if (line[pos] === '<') {
			const jsxMatch = line.slice(pos).match(/^<(\/?)([a-zA-Z_$][\w$.]*)/);
			if (jsxMatch) {
				const [full, slash, tagName] = jsxMatch;
				// Emit < and optional /
				result.push(`<span class="shil-hl-punct">&lt;${esc(slash)}</span>`);
				result.push(`<span class="shil-hl-tag">${esc(tagName)}</span>`);
				pos += full.length;

				// Scan JSX attributes until > or />
				while (pos < line.length) {
					// Whitespace
					if (/\s/.test(line[pos])) {
						result.push(line[pos]);
						pos++;
						continue;
					}
					// Closing > or />
					if (line[pos] === '>' || (line[pos] === '/' && line[pos + 1] === '>')) {
						if (line[pos] === '/') {
							result.push(`<span class="shil-hl-punct">/&gt;</span>`);
							pos += 2;
						} else {
							result.push(`<span class="shil-hl-punct">&gt;</span>`);
							pos++;
						}
						break;
					}
					// Attribute name
					const attrMatch = line.slice(pos).match(/^[a-zA-Z_$][\w$-]*/);
					if (attrMatch) {
						result.push(`<span class="shil-hl-attr">${esc(attrMatch[0])}</span>`);
						pos += attrMatch[0].length;
						continue;
					}
					// = sign
					if (line[pos] === '=') {
						result.push(`<span class="shil-hl-punct">=</span>`);
						pos++;
						continue;
					}
					// String values
					if (line[pos] === '"' || line[pos] === "'") {
						const q = line[pos];
						let end = pos + 1;
						while (end < line.length && line[end] !== q) {
							if (line[end] === '\\') { end++; }
							end++;
						}
						if (end < line.length) { end++; }
						result.push(`<span class="shil-hl-string">${esc(line.slice(pos, end))}</span>`);
						pos = end;
						continue;
					}
					// { expression } — just emit the brace and let the main loop handle the rest
					if (line[pos] === '{') {
						break; // exit JSX attribute scanning, main loop handles {
					}
					// Anything else
					result.push(esc(line[pos]));
					pos++;
				}
				continue;
			}
		}

		// 7b. Decorators (@)
		if (line[pos] === '@') {
			const decMatch = line.slice(pos).match(/^@[\w$]+/);
			if (decMatch) {
				result.push(`<span class="shil-hl-type">${esc(decMatch[0])}</span>`);
				pos += decMatch[0].length;
				continue;
			}
		}

		// 8. Arrow operator => (keyword-colored, not punctuation)
		if (line[pos] === '=' && line[pos + 1] === '>') {
			result.push(`<span class="shil-hl-keyword">=&gt;</span>`);
			pos += 2;
			continue;
		}

		// 8b. Optional chaining ?. (distinct from regular . access)
		if (line[pos] === '?' && line[pos + 1] === '.') {
			// Ensure it's not ?. followed by a digit (which would be a conditional with a number literal)
			if (pos + 2 >= line.length || !/\d/.test(line[pos + 2])) {
				result.push(`<span class="shil-hl-optchain">?.</span>`);
				pos += 2;
				continue;
			}
		}

		// 8c. Generic type parameters <T extends Base> after type-like identifiers
		if (line[pos] === '<') {
			// Look back to see if preceded by a type name (PascalCase, builtin type, or after : / as / extends)
			const before = line.slice(0, pos);
			const typeBeforeMatch = before.match(/(?:^|[\s,;:=(])\s*([A-Z][\w$]*)\s*$/);
			const contextMatch = before.match(/(?::\s*|as\s+|extends\s+|implements\s+|&\s*|\|\s*)([A-Za-z_$][\w$]*)\s*$/);
			if (typeBeforeMatch || contextMatch) {
				// Try to match balanced angle brackets with type content
				const rest = line.slice(pos);
				const genericMatch = rest.match(/^<([A-Za-z_$\s,\[\]|&?:.=\w$()'"]+)>/);
				if (genericMatch) {
					result.push(`<span class="shil-hl-punct">&lt;</span>`);
					result.push(`<span class="shil-hl-type">${esc(genericMatch[1])}</span>`);
					result.push(`<span class="shil-hl-punct">&gt;</span>`);
					pos += genericMatch[0].length;
					continue;
				}
			}
		}

		// 9. Punctuation
		if (/[{}()[\];:.,<>!=+\-*/%&|^~?]/.test(line[pos])) {
			result.push(`<span class="shil-hl-punct">${esc(line[pos])}</span>`);
			pos++;
			continue;
		}

		// 10. Anything else (whitespace, etc.)
		result.push(esc(line[pos]));
		pos++;
	}

	return result.join('');
}

const KEYWORDS = new Set([
	'abstract', 'as', 'async', 'await', 'break', 'case', 'catch', 'class',
	'const', 'continue', 'debugger', 'declare', 'default', 'delete', 'do',
	'else', 'enum', 'export', 'extends', 'finally', 'for', 'from', 'function',
	'get', 'if', 'implements', 'import', 'in', 'instanceof', 'interface',
	'is', 'keyof', 'let', 'module', 'namespace', 'new', 'of', 'override',
	'private', 'protected', 'public', 'readonly', 'return', 'satisfies',
	'set', 'static', 'super', 'switch', 'this', 'throw', 'try', 'type',
	'typeof', 'var', 'void', 'while', 'with', 'yield',
]);

const CONSTANTS = new Set([
	'true', 'false', 'null', 'undefined', 'NaN', 'Infinity',
]);

const BUILTIN_TYPES = new Set([
	'Array', 'Boolean', 'Date', 'Error', 'Function', 'Map', 'Number',
	'Object', 'Promise', 'RegExp', 'Set', 'String', 'Symbol', 'WeakMap',
	'WeakSet', 'Record', 'Partial', 'Required', 'Readonly', 'Pick', 'Omit',
	'Exclude', 'Extract', 'ReturnType', 'Parameters', 'InstanceType',
	'Awaited', 'NonNullable',
]);

/** TypeScript primitive type keywords used in annotations (`: string`, `: number`, etc.) */
const TS_PRIMITIVE_TYPES = new Set([
	'string', 'number', 'boolean', 'void', 'any', 'unknown', 'never',
	'object', 'bigint', 'symbol', 'undefined', 'null',
]);

function tokenClass(word: string): string | undefined {
	if (KEYWORDS.has(word)) {
		return 'shil-hl-keyword';
	}
	if (CONSTANTS.has(word)) {
		return 'shil-hl-number'; // constants use the same color as numbers in Shil Dark
	}
	if (BUILTIN_TYPES.has(word)) {
		return 'shil-hl-type';
	}
	// Heuristic: PascalCase words are likely types/classes
	if (/^[A-Z][a-zA-Z\d]+$/.test(word) && word.length > 1) {
		return 'shil-hl-type';
	}
	return undefined;
}

/** Check if a name looks like a type (TS primitives, PascalCase, or builtin utility types). */
function isTypeName(name: string): boolean {
	if (TS_PRIMITIVE_TYPES.has(name) || BUILTIN_TYPES.has(name)) {
		return true;
	}
	// PascalCase heuristic: starts with uppercase, has at least one lowercase letter
	if (/^[A-Z][a-zA-Z\d]+$/.test(name) && name.length > 1) {
		return true;
	}
	return false;
}

/** Escape HTML special characters. */
function esc(s: string): string {
	return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
