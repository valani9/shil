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
import type { ReaderDoc, ReaderSpan, SpanKind } from './shilReaderTypes.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';

export class ShilReaderPane extends EditorPane {

	static readonly ID = SHIL_READER_EDITOR_ID;

	private container: HTMLElement | undefined;
	private contentElement: HTMLElement | undefined;
	private currentDoc: ReaderDoc | undefined;
	private readonly paneDisposables = this._register(new DisposableStore());

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@ILanguageService private readonly languageService: ILanguageService,
	) {
		super(ShilReaderPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = document.createElement('div');
		this.container.className = 'shil-reader-container';

		this.contentElement = document.createElement('div');
		this.contentElement.className = 'shil-reader-content';
		this.container.appendChild(this.contentElement);

		parent.appendChild(this.container);
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);

		if (!(input instanceof ShilReaderInput)) {
			return;
		}

		this.paneDisposables.clear();

		try {
			const content = await this.fileService.readFile(input.fileResource);
			if (token.isCancellationRequested) {
				return;
			}

			const source = content.value.toString();
			const languageId = this.languageService.guessLanguageIdByFilepathOrFirstLine(input.fileResource) ?? 'plaintext';
			this.currentDoc = parseToReaderDoc(source, input.fileResource.path, languageId);
			this.renderDoc(this.currentDoc);
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

		// Line range reference
		const lineRef = document.createElement('span');
		lineRef.className = 'shil-reader-span-lines';
		lineRef.textContent = span.lineStart === span.lineEnd
			? `line ${span.lineStart}`
			: `lines ${span.lineStart}\u2013${span.lineEnd}`;
		el.appendChild(lineRef);

		// Code excerpt (collapsed, first 3 lines)
		const sourceLines = doc.source.split('\n');
		const excerptLines = sourceLines.slice(span.lineStart - 1, Math.min(span.lineEnd, span.lineStart + 2));
		if (excerptLines.length > 0) {
			const code = document.createElement('pre');
			code.className = 'shil-reader-span-code';
			const codeInner = document.createElement('code');
			codeInner.textContent = excerptLines.join('\n') + (span.lineEnd - span.lineStart >= 3 ? '\n\u2026' : '');
			code.appendChild(codeInner);
			el.appendChild(code);
		}

		return el;
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

	override clearInput(): void {
		super.clearInput();
		this.paneDisposables.clear();
		this.currentDoc = undefined;
		if (this.contentElement) {
			this.contentElement.textContent = '';
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
