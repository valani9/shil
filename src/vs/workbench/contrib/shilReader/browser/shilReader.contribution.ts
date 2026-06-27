/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions } from '../../../common/editor.js';
import { IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorPaneDescriptor } from '../../../browser/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ShilReaderInput, SHIL_READER_EDITOR_ID } from './shilReaderInput.js';
import { ShilReaderPane } from './shilReaderPane.js';
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyCode, KeyMod } from '../../../../base/common/keyCodes.js';
import { EditorResourceAccessor } from '../../../common/editor.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IShilModelService, ShilModelService } from './shilModelService.js';
import { Extensions as ConfigExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';

// Register the editor pane → input binding
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		ShilReaderPane,
		SHIL_READER_EDITOR_ID,
		localize('shilReader', "Reader")
	),
	[
		new SyncDescriptor(ShilReaderInput)
	]
);

// Toggle Reader command: flip between code editor and reader pane for the active file
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'shil.toggleReader',
			title: localize2('shil.toggleReader', 'Toggle Reader View'),
			category: Categories.View,
			f1: true,
			keybinding: {
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyCode.KeyR,
			},
		});
	}

	run(accessor: ServicesAccessor): void {
		const editorService = accessor.get(IEditorService);
		const activeEditor = editorService.activeEditor;

		if (!activeEditor) {
			return;
		}

		// If currently in reader mode, flip back to the code editor
		if (activeEditor instanceof ShilReaderInput) {
			editorService.openEditor({
				resource: activeEditor.fileResource,
				options: { pinned: true }
			});
			return;
		}

		// Get the resource of the active text editor
		const resource = EditorResourceAccessor.getOriginalUri(activeEditor);
		if (!resource) {
			return;
		}

		// Open the reader for this file
		const readerInput = new ShilReaderInput(resource);
		editorService.openEditor(readerInput, { pinned: true });
	}
});

// ── Model service registration ──
registerSingleton(IShilModelService, ShilModelService, InstantiationType.Delayed);

// ── Model configuration ──
Registry.as<IConfigurationRegistry>(ConfigExtensions.Configuration).registerConfiguration({
	id: 'shil',
	title: localize('shil', "Shil"),
	type: 'object',
	properties: {
		'shil.model.cliCommand': {
			type: 'string',
			default: '',
			description: localize('shil.model.cliCommand.desc', "CLI command for AI span generation (e.g. your installed AI coding CLI). Leave empty for auto-detection."),
		},
		'shil.model.provider': {
			type: 'string',
			default: 'openai',
			enum: ['openai', 'anthropic', 'ollama'],
			enumDescriptions: [
				localize('shil.model.provider.openai', "OpenAI or OpenAI-compatible API"),
				localize('shil.model.provider.anthropic', "Anthropic Messages API"),
				localize('shil.model.provider.ollama', "Local Ollama server"),
			],
			description: localize('shil.model.provider.desc', "AI provider for the Reader's plain-English generation (used as fallback when CLI delegation is unavailable)."),
		},
		'shil.model.apiKey': {
			type: 'string',
			default: '',
			description: localize('shil.model.apiKey.desc', "API key for the selected provider. The Reader uses your installed CLI by default (no key needed). Set this only as a manual fallback."),
		},
		'shil.model.endpoint': {
			type: 'string',
			default: '',
			description: localize('shil.model.endpoint.desc', "API endpoint URL. Defaults: OpenAI=https://api.openai.com/v1/chat/completions, Anthropic=https://api.anthropic.com/v1/messages, Ollama=http://localhost:11434/v1/chat/completions"),
		},
		'shil.model.model': {
			type: 'string',
			default: '',
			description: localize('shil.model.model.desc', "Model ID to use (e.g. gpt-4o-mini, llama3.2, or your provider's model name)."),
		},
	},
});
