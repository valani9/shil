/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { URI } from '../../../../base/common/uri.js';
import { IUntypedEditorInput } from '../../../common/editor.js';

export const SHIL_WELCOME_EDITOR_ID = 'workbench.editors.shilWelcome';

export class ShilWelcomeInput extends EditorInput {

	static readonly ID = SHIL_WELCOME_EDITOR_ID;

	override get typeId(): string {
		return ShilWelcomeInput.ID;
	}

	override get editorId(): string | undefined {
		return this.typeId;
	}

	override get resource(): URI | undefined {
		return undefined;
	}

	override getName(): string {
		return localize('shilWelcome.name', 'Welcome');
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		return other instanceof ShilWelcomeInput;
	}
}
