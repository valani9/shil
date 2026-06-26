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
		// Prevent keyboard nav from stealing search keystrokes
		searchInput.addEventListener('keydown', (e) => e.stopPropagation());
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
				lineTd.textContent = excerptLines[i];
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
