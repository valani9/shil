/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { EditorExtensions } from '../../../common/editor.js';
import { IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorPaneDescriptor } from '../../../browser/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { ShilWelcomeInput, SHIL_WELCOME_EDITOR_ID } from './shilWelcomeInput.js';
import { ShilWelcomePane } from './shilWelcomePane.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ILifecycleService, LifecyclePhase, StartupKind } from '../../../services/lifecycle/common/lifecycle.js';
import { IProductService } from '../../../../platform/product/common/productService.js';

// Register the editor pane
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		ShilWelcomePane,
		SHIL_WELCOME_EDITOR_ID,
		localize('shilWelcome', "Welcome")
	),
	[
		new SyncDescriptor(ShilWelcomeInput)
	]
);

const SHIL_WELCOME_SHOWN_KEY = 'shil.welcome.shown';

/**
 * Opens the Shil welcome page on first launch (fresh profile).
 */
class ShilWelcomeStartupContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.shilWelcomeStartup';

	constructor(
		@IEditorService private readonly editorService: IEditorService,
		@IStorageService private readonly storageService: IStorageService,
		@ILifecycleService private readonly lifecycleService: ILifecycleService,
		@IProductService private readonly productService: IProductService,
	) {
		super();
		this.open();
	}

	private async open(): Promise<void> {
		// Wait until restored to reduce startup pressure
		await this.lifecycleService.when(LifecyclePhase.Restored);

		// Only on fresh startup, not reload
		if (this.lifecycleService.startupKind === StartupKind.ReloadedWindow) {
			return;
		}

		// Only for Shil (not upstream Code-OSS test builds)
		if (this.productService.nameShort === 'Code - OSS') {
			return;
		}

		// Show on first launch only, or when no editors are open
		const hasShownBefore = this.storageService.getBoolean(SHIL_WELCOME_SHOWN_KEY, StorageScope.PROFILE, false);

		if (!hasShownBefore || !this.editorService.activeEditor) {
			this.storageService.store(SHIL_WELCOME_SHOWN_KEY, true, StorageScope.PROFILE, StorageTarget.USER);
			const input = new ShilWelcomeInput();
			this.editorService.openEditor(input, { pinned: false });
		}
	}
}

registerWorkbenchContribution2(ShilWelcomeStartupContribution.ID, ShilWelcomeStartupContribution, WorkbenchPhase.AfterRestored);
