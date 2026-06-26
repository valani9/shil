/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { URI } from '../../../../base/common/uri.js';
import { IUntypedEditorInput } from '../../../common/editor.js';
import { basename } from '../../../../base/common/resources.js';

export const SHIL_READER_EDITOR_ID = 'workbench.editors.shilReader';

export class ShilReaderInput extends EditorInput {

	static readonly ID = SHIL_READER_EDITOR_ID;

	constructor(
		readonly fileResource: URI
	) {
		super();
	}

	override get typeId(): string {
		return ShilReaderInput.ID;
	}

	override get editorId(): string | undefined {
		return this.typeId;
	}

	override get resource(): URI {
		return this.fileResource;
	}

	override getName(): string {
		return localize('shilReader.name', '{0} (Reader)', basename(this.fileResource));
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (super.matches(other)) {
			return true;
		}
		if (other instanceof ShilReaderInput) {
			return other.fileResource.toString() === this.fileResource.toString();
		}
		return false;
	}

	override get capabilities(): number {
		return super.capabilities;
	}
}
