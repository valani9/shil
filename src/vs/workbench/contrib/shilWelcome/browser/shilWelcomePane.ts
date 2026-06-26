/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/shilWelcome.css';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { SHIL_WELCOME_EDITOR_ID } from './shilWelcomeInput.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

export class ShilWelcomePane extends EditorPane {

	static readonly ID = SHIL_WELCOME_EDITOR_ID;

	private container: HTMLElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@ICommandService private readonly commandService: ICommandService,
	) {
		super(ShilWelcomePane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		this.container = document.createElement('div');
		this.container.className = 'shil-welcome';
		parent.appendChild(this.container);

		const inner = document.createElement('div');
		inner.className = 'shil-welcome-inner';
		this.container.appendChild(inner);

		// ── Brand mark ──
		const brand = document.createElement('div');
		brand.className = 'shil-welcome-brand';

		const logo = document.createElement('div');
		logo.className = 'shil-welcome-logo';
		logo.textContent = 'shil';
		brand.appendChild(logo);

		const tagline = document.createElement('div');
		tagline.className = 'shil-welcome-tagline';
		tagline.textContent = 'Your code, explained in plain English.';
		brand.appendChild(tagline);

		inner.appendChild(brand);

		// ── Quick actions ──
		const actions = document.createElement('div');
		actions.className = 'shil-welcome-actions';

		const isMac = navigator.userAgent.includes('Mac');
		const mod = isMac ? '\u2318' : 'Ctrl';

		this.addAction(actions, 'Open File', `${mod}+O`, 'workbench.action.files.openFile');
		this.addAction(actions, 'Open Folder', `${mod}+K ${mod}+O`, 'workbench.action.files.openFolder');
		this.addAction(actions, 'Open Recent', `${mod}+R`, 'workbench.action.openRecent');
		this.addAction(actions, 'Toggle Reader', `${mod}+\u21E7+R`, 'shil.toggleReader');
		this.addAction(actions, 'Command Palette', `${mod}+\u21E7+P`, 'workbench.action.showCommands');

		inner.appendChild(actions);

		// ── Keyboard hint ──
		const hint = document.createElement('div');
		hint.className = 'shil-welcome-hint';
		hint.append(
			'Press ',
			this.createKbd(`${mod}+\u21E7+R`),
			' on any file to read it in plain English.'
		);
		inner.appendChild(hint);
	}

	private createKbd(text: string): HTMLElement {
		const kbd = document.createElement('kbd');
		kbd.textContent = text;
		return kbd;
	}

	private addAction(parent: HTMLElement, label: string, key: string, commandId: string): void {
		const row = document.createElement('div');
		row.className = 'shil-welcome-action';

		const labelEl = document.createElement('span');
		labelEl.className = 'shil-welcome-action-label';
		labelEl.textContent = label;
		row.appendChild(labelEl);

		const keyEl = document.createElement('span');
		keyEl.className = 'shil-welcome-action-key';
		keyEl.textContent = key;
		row.appendChild(keyEl);

		row.addEventListener('click', () => {
			this.commandService.executeCommand(commandId);
		});

		parent.appendChild(row);
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
	}

	override layout(dimension: Dimension): void {
		if (this.container) {
			this.container.style.width = `${dimension.width}px`;
			this.container.style.height = `${dimension.height}px`;
		}
	}
}
