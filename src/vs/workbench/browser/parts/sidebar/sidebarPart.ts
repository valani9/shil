/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/sidebarpart.css';
import './sidebarActions.js';
import { ActivityBarPosition, IWorkbenchLayoutService, LayoutSettings, Parts, Position as SideBarPosition } from '../../../services/layout/browser/layoutService.js';
import { SidebarFocusContext, ActiveViewletContext } from '../../../common/contextkeys.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { contrastBorder } from '../../../../platform/theme/common/colorRegistry.js';
import { SIDE_BAR_TITLE_FOREGROUND, SIDE_BAR_TITLE_BORDER, SIDE_BAR_BACKGROUND, SIDE_BAR_FOREGROUND, SIDE_BAR_BORDER, SIDE_BAR_DRAG_AND_DROP_BACKGROUND, ACTIVITY_BAR_BADGE_BACKGROUND, ACTIVITY_BAR_BADGE_FOREGROUND, ACTIVITY_BAR_TOP_FOREGROUND, ACTIVITY_BAR_TOP_ACTIVE_BORDER, ACTIVITY_BAR_TOP_INACTIVE_FOREGROUND, ACTIVITY_BAR_TOP_DRAG_AND_DROP_BORDER } from '../../../common/theme.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { AnchorAlignment } from '../../../../base/browser/ui/contextview/contextview.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { LayoutPriority } from '../../../../base/browser/ui/grid/grid.js';
import { assertReturnsDefined } from '../../../../base/common/types.js';
import { IViewDescriptorService, ViewContainerLocation } from '../../../common/views.js';
import { AbstractPaneCompositePart, CompositeBarPosition } from '../paneCompositePart.js';
import { ActivityBarCompositeBar, ActivitybarPart } from '../activitybar/activitybarPart.js';
import { ActionsOrientation } from '../../../../base/browser/ui/actionbar/actionbar.js';
import { HoverPosition } from '../../../../base/browser/ui/hover/hoverWidget.js';
import { IPaneCompositeBarOptions } from '../paneCompositeBar.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Action2, IMenuService, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Separator } from '../../../../base/common/actions.js';
import { ToggleActivityBarVisibilityActionId } from '../../actions/layoutActions.js';
import { localize2 } from '../../../../nls.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { VisibleViewContainersTracker } from '../visibleViewContainersTracker.js';
import { Extensions } from '../../panecomposite.js';
import { $, addDisposableListener, EventType, getWindow, isAncestorUsingFlowTo } from '../../../../base/browser/dom.js';

export class SidebarPart extends AbstractPaneCompositePart {

	static readonly activeViewletSettingsKey = 'workbench.sidebar.activeviewletid';

	//#region IView

	readonly minimumWidth: number = 1;
	readonly maximumWidth: number = Number.POSITIVE_INFINITY;
	readonly minimumHeight: number = 0;
	readonly maximumHeight: number = Number.POSITIVE_INFINITY;
	override get snap(): boolean { return true; }

	readonly priority: LayoutPriority = LayoutPriority.Low;

	get preferredWidth(): number | undefined {
		const viewlet = this.getActivePaneComposite();

		if (!viewlet) {
			return undefined;
		}

		const width = viewlet.getOptimalWidth();
		if (typeof width !== 'number') {
			return undefined;
		}

		return Math.max(width, 300);
	}

	private readonly activityBarPart = this._register(this.instantiationService.createInstance(ActivitybarPart, this.location, this));
	private readonly visibleViewContainersTracker: VisibleViewContainersTracker;

	//#endregion

	constructor(
		@INotificationService notificationService: INotificationService,
		@IStorageService storageService: IStorageService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IWorkbenchLayoutService layoutService: IWorkbenchLayoutService,
		@IKeybindingService keybindingService: IKeybindingService,
		@IHoverService hoverService: IHoverService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IThemeService themeService: IThemeService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IExtensionService extensionService: IExtensionService,
		@IConfigurationService configurationService: IConfigurationService,
		@IMenuService menuService: IMenuService,
	) {
		super(
			Parts.SIDEBAR_PART,
			{ hasTitle: true, trailingSeparator: false, borderWidth: () => (this.getColor(SIDE_BAR_BORDER) || this.getColor(contrastBorder)) ? 1 : 0 },
			SidebarPart.activeViewletSettingsKey,
			ActiveViewletContext.bindTo(contextKeyService),
			SidebarFocusContext.bindTo(contextKeyService),
			'sideBar',
			'viewlet',
			SIDE_BAR_TITLE_FOREGROUND,
			SIDE_BAR_TITLE_BORDER,
			ViewContainerLocation.Sidebar,
			Extensions.Viewlets,
			MenuId.SidebarTitle,
			notificationService,
			storageService,
			contextMenuService,
			layoutService,
			keybindingService,
			hoverService,
			instantiationService,
			themeService,
			viewDescriptorService,
			contextKeyService,
			extensionService,
			menuService,
			configurationService,
		);

		// Track visible view containers for auto-hide
		this.visibleViewContainersTracker = this._register(instantiationService.createInstance(VisibleViewContainersTracker, ViewContainerLocation.Sidebar));
		this._register(this.visibleViewContainersTracker.onDidChange((e) => this.onDidChangeAutoHideViewContainers(e)));

		this.rememberActivityBarVisiblePosition();
		this._register(configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(LayoutSettings.ACTIVITY_BAR_LOCATION)) {
				this.onDidChangeActivityBarLocation();
			}
			if (e.affectsConfiguration(LayoutSettings.ACTIVITY_BAR_AUTO_HIDE)) {
				this.onDidChangeActivityBarLocation();
			}
		}));

		this.registerActions();
	}

	private onDidChangeAutoHideViewContainers(e: { before: number; after: number }): void {
		// Only update if auto-hide is enabled and composite bar position is top/bottom
		const activityBarPosition = this.configurationService.getValue<ActivityBarPosition>(LayoutSettings.ACTIVITY_BAR_LOCATION);
		const autoHide = this.configurationService.getValue<boolean>(LayoutSettings.ACTIVITY_BAR_AUTO_HIDE);
		if (autoHide && (activityBarPosition === ActivityBarPosition.TOP || activityBarPosition === ActivityBarPosition.BOTTOM)) {
			const visibleBefore = e.before > 1;
			const visibleAfter = e.after > 1;
			if (visibleBefore !== visibleAfter) {
				this.onDidChangeActivityBarLocation();
			}
		}
	}

	private onDidChangeActivityBarLocation(): void {
		this.activityBarPart.hide();

		this.updateCompositeBar();

		const id = this.getActiveComposite()?.getId();
		if (id) {
			this.onTitleAreaUpdate(id);
		}

		if (this.shouldShowActivityBar()) {
			this.activityBarPart.show();
		}

		this.rememberActivityBarVisiblePosition();
	}

	override updateStyles(): void {
		super.updateStyles();

		const container = assertReturnsDefined(this.getContainer());

		container.style.backgroundColor = this.getColor(SIDE_BAR_BACKGROUND) || '';
		container.style.color = this.getColor(SIDE_BAR_FOREGROUND) || '';

		const borderColor = this.getColor(SIDE_BAR_BORDER) || this.getColor(contrastBorder);
		const isPositionLeft = this.layoutService.getSideBarPosition() === SideBarPosition.LEFT;
		container.style.borderRightWidth = borderColor && isPositionLeft ? '1px' : '';
		container.style.borderRightStyle = borderColor && isPositionLeft ? 'solid' : '';
		container.style.borderRightColor = isPositionLeft ? borderColor || '' : '';
		container.style.borderLeftWidth = borderColor && !isPositionLeft ? '1px' : '';
		container.style.borderLeftStyle = borderColor && !isPositionLeft ? 'solid' : '';
		container.style.borderLeftColor = !isPositionLeft ? borderColor || '' : '';
		container.style.outlineColor = this.getColor(SIDE_BAR_DRAG_AND_DROP_BACKGROUND) ?? '';
	}

	private static readonly SHIL_OVERLAY_DEFAULT_WIDTH = 280;
	private static readonly SHIL_OVERLAY_MIN_WIDTH = 200;
	private static readonly SHIL_OVERLAY_MAX_WIDTH = 600;
	private static readonly SHIL_WIDTH_STORAGE_KEY = 'shil.sidebar.overlayWidth';

	private _shilOverlayWidth = SidebarPart.SHIL_OVERLAY_DEFAULT_WIDTH;

	override create(parent: HTMLElement): void {
		super.create(parent);

		// Shil: real scrim element for click-to-dismiss (replaces CSS ::after pseudo).
		const workbench = parent.closest('.monaco-workbench');
		if (workbench) {
			const scrim = $('.shil-sidebar-scrim');
			workbench.appendChild(scrim);
			this._register(addDisposableListener(scrim, EventType.MOUSE_DOWN, (e: MouseEvent) => {
				e.preventDefault();
				e.stopPropagation();
				this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
			}));
		}

		// Shil: Escape key dismisses sidebar when it has focus (keyboard complement to scrim click).
		this._register(addDisposableListener(parent, EventType.KEY_DOWN, (e: KeyboardEvent) => {
			if (e.key === 'Escape' && this.layoutService.isVisible(Parts.SIDEBAR_PART)) {
				// Only dismiss if focus is inside the sidebar or activity bar
				const active = parent.ownerDocument.activeElement;
				if (active && (isAncestorUsingFlowTo(active, parent) || isAncestorUsingFlowTo(active, parent.closest('.monaco-workbench')?.querySelector('.part.activitybar') ?? parent))) {
					e.preventDefault();
					e.stopPropagation();
					this.layoutService.setPartHidden(true, Parts.SIDEBAR_PART);
				}
			}
		}));

		// Restore persisted width
		const stored = this.storageService.getNumber(
			SidebarPart.SHIL_WIDTH_STORAGE_KEY,
			StorageScope.PROFILE,
			SidebarPart.SHIL_OVERLAY_DEFAULT_WIDTH
		);
		this._shilOverlayWidth = Math.max(
			SidebarPart.SHIL_OVERLAY_MIN_WIDTH,
			Math.min(SidebarPart.SHIL_OVERLAY_MAX_WIDTH, stored)
		);
		this.applyOverlayWidth();

		// Create the drag resize handle at the right edge
		const handle = $('.shil-sidebar-resize-handle');
		parent.appendChild(handle);

		let startX = 0;
		let startWidth = 0;

		const onMouseMove = (e: MouseEvent) => {
			const delta = e.clientX - startX;
			const newWidth = Math.max(
				SidebarPart.SHIL_OVERLAY_MIN_WIDTH,
				Math.min(SidebarPart.SHIL_OVERLAY_MAX_WIDTH, startWidth + delta)
			);
			this._shilOverlayWidth = newWidth;
			this.applyOverlayWidth();
			// Re-layout internal content at the new width using the container's
			// current client height (the overlay is position:fixed, so this is
			// the actual rendered height).
			const container = this.getContainer();
			const h = container ? container.clientHeight : 0;
			super.layout(newWidth, h, 0, 0);
		};

		const onMouseUp = () => {
			const win = getWindow(parent);
			win.document.body.classList.remove('shil-sidebar-resizing');
			win.removeEventListener('mousemove', onMouseMove);
			win.removeEventListener('mouseup', onMouseUp);
			// Persist the width
			this.storageService.store(
				SidebarPart.SHIL_WIDTH_STORAGE_KEY,
				this._shilOverlayWidth,
				StorageScope.PROFILE,
				StorageTarget.USER
			);
		};

		this._register(addDisposableListener(handle, EventType.MOUSE_DOWN, (e: MouseEvent) => {
			e.preventDefault();
			startX = e.clientX;
			startWidth = this._shilOverlayWidth;
			const win = getWindow(parent);
			win.document.body.classList.add('shil-sidebar-resizing');
			win.addEventListener('mousemove', onMouseMove);
			win.addEventListener('mouseup', onMouseUp);
		}));

		// Double-click to reset to default width
		this._register(addDisposableListener(handle, EventType.DBLCLICK, () => {
			this._shilOverlayWidth = SidebarPart.SHIL_OVERLAY_DEFAULT_WIDTH;
			this.applyOverlayWidth();
			super.layout(this._shilOverlayWidth, 0, 0, 0);
			this.storageService.store(
				SidebarPart.SHIL_WIDTH_STORAGE_KEY,
				this._shilOverlayWidth,
				StorageScope.PROFILE,
				StorageTarget.USER
			);
		}));
	}

	private applyOverlayWidth(): void {
		const container = this.getContainer();
		if (container) {
			container.style.setProperty('--shil-sidebar-width', `${this._shilOverlayWidth}px`);
		}
	}

	override layout(width: number, height: number, top: number, left: number): void {
		if (!this.layoutService.isVisible(Parts.SIDEBAR_PART)) {
			return;
		}

		// Shil: sidebar is a CSS fixed overlay. The grid allocates 1px, but
		// internal content layout must use the actual overlay width so tree
		// views, composite bars, etc. render at the correct size.
		super.layout(this._shilOverlayWidth, height, top, left);
	}

	protected override getTitleAreaDropDownAnchorAlignment(): AnchorAlignment {
		return this.layoutService.getSideBarPosition() === SideBarPosition.LEFT ? AnchorAlignment.LEFT : AnchorAlignment.RIGHT;
	}

	protected override createCompositeBar(): ActivityBarCompositeBar {
		return this.instantiationService.createInstance(ActivityBarCompositeBar, ViewContainerLocation.Sidebar, this.getCompositeBarOptions(), this.partId, this, false);
	}

	protected getCompositeBarOptions(): IPaneCompositeBarOptions {
		return {
			partContainerClass: 'sidebar',
			pinnedViewContainersKey: ActivitybarPart.pinnedViewContainersKey,
			placeholderViewContainersKey: ActivitybarPart.placeholderViewContainersKey,
			viewContainersWorkspaceStateKey: ActivitybarPart.viewContainersWorkspaceStateKey,
			icon: true,
			orientation: ActionsOrientation.HORIZONTAL,
			recomputeSizes: true,
			activityHoverOptions: {
				position: () => this.getCompositeBarPosition() === CompositeBarPosition.BOTTOM ? HoverPosition.ABOVE : HoverPosition.BELOW,
			},
			fillExtraContextMenuActions: actions => {
				if (this.getCompositeBarPosition() === CompositeBarPosition.TITLE) {
					const viewsSubmenuAction = this.getViewsSubmenuAction();
					if (viewsSubmenuAction) {
						actions.push(new Separator());
						actions.push(viewsSubmenuAction);
					}
				}
			},
			compositeSize: 0,
			iconSize: 16,
			overflowActionSize: 30,
			colors: theme => ({
				activeBackgroundColor: theme.getColor(SIDE_BAR_BACKGROUND),
				inactiveBackgroundColor: theme.getColor(SIDE_BAR_BACKGROUND),
				activeBorderBottomColor: theme.getColor(ACTIVITY_BAR_TOP_ACTIVE_BORDER),
				activeForegroundColor: theme.getColor(ACTIVITY_BAR_TOP_FOREGROUND),
				inactiveForegroundColor: theme.getColor(ACTIVITY_BAR_TOP_INACTIVE_FOREGROUND),
				badgeBackground: theme.getColor(ACTIVITY_BAR_BADGE_BACKGROUND),
				badgeForeground: theme.getColor(ACTIVITY_BAR_BADGE_FOREGROUND),
				dragAndDropBorder: theme.getColor(ACTIVITY_BAR_TOP_DRAG_AND_DROP_BORDER)
			}),
			compact: true
		};
	}

	protected shouldShowCompositeBar(): boolean {
		const activityBarPosition = this.configurationService.getValue<ActivityBarPosition>(LayoutSettings.ACTIVITY_BAR_LOCATION);
		if (activityBarPosition !== ActivityBarPosition.TOP && activityBarPosition !== ActivityBarPosition.BOTTOM) {
			return false;
		}

		// Check if auto-hide is enabled and there's only one visible view container
		const autoHide = this.configurationService.getValue<boolean>(LayoutSettings.ACTIVITY_BAR_AUTO_HIDE);
		if (autoHide) {
			// Use visible composite count from the composite bar if available (considers pinned state),
			// otherwise fall back to the tracker's count (based on active view descriptors).
			// Note: We access paneCompositeBar directly to avoid circular calls with getVisiblePaneCompositeIds()
			const visibleCount = this.visibleViewContainersTracker.visibleCount;
			if (visibleCount <= 1) {
				return false;
			}
		}

		return true;
	}

	private shouldShowActivityBar(): boolean {
		if (this.shouldShowCompositeBar()) {
			return false;
		}

		return this.configurationService.getValue(LayoutSettings.ACTIVITY_BAR_LOCATION) !== ActivityBarPosition.HIDDEN;
	}

	protected getCompositeBarPosition(): CompositeBarPosition {
		const activityBarPosition = this.configurationService.getValue<ActivityBarPosition>(LayoutSettings.ACTIVITY_BAR_LOCATION);
		switch (activityBarPosition) {
			case ActivityBarPosition.TOP: return CompositeBarPosition.TOP;
			case ActivityBarPosition.BOTTOM: return CompositeBarPosition.BOTTOM;
			case ActivityBarPosition.HIDDEN:
			case ActivityBarPosition.DEFAULT: // noop
			default: return CompositeBarPosition.TITLE;
		}
	}

	private rememberActivityBarVisiblePosition(): void {
		const activityBarPosition = this.configurationService.getValue<string>(LayoutSettings.ACTIVITY_BAR_LOCATION);
		if (activityBarPosition !== ActivityBarPosition.HIDDEN) {
			this.storageService.store(LayoutSettings.ACTIVITY_BAR_LOCATION, activityBarPosition, StorageScope.PROFILE, StorageTarget.USER);
		}
	}

	private getRememberedActivityBarVisiblePosition(): ActivityBarPosition {
		const activityBarPosition = this.storageService.get(LayoutSettings.ACTIVITY_BAR_LOCATION, StorageScope.PROFILE);
		switch (activityBarPosition) {
			case ActivityBarPosition.TOP: return ActivityBarPosition.TOP;
			case ActivityBarPosition.BOTTOM: return ActivityBarPosition.BOTTOM;
			default: return ActivityBarPosition.DEFAULT;
		}
	}

	override getPinnedPaneCompositeIds(): string[] {
		return this.shouldShowCompositeBar() ? super.getPinnedPaneCompositeIds() : this.activityBarPart.getPinnedPaneCompositeIds();
	}

	override getVisiblePaneCompositeIds(): string[] {
		return this.shouldShowCompositeBar() ? super.getVisiblePaneCompositeIds() : this.activityBarPart.getVisiblePaneCompositeIds();
	}

	override getPaneCompositeIds(): string[] {
		return this.shouldShowCompositeBar() ? super.getPaneCompositeIds() : this.activityBarPart.getPaneCompositeIds();
	}

	async focusActivityBar(): Promise<void> {
		if (this.configurationService.getValue(LayoutSettings.ACTIVITY_BAR_LOCATION) === ActivityBarPosition.HIDDEN) {
			await this.configurationService.updateValue(LayoutSettings.ACTIVITY_BAR_LOCATION, this.getRememberedActivityBarVisiblePosition());

			this.onDidChangeActivityBarLocation();
		}

		if (this.shouldShowCompositeBar()) {
			this.focusCompositeBar();
		} else {
			if (!this.layoutService.isVisible(Parts.ACTIVITYBAR_PART)) {
				this.layoutService.setPartHidden(false, Parts.ACTIVITYBAR_PART);
			}

			this.activityBarPart.show(true);
		}
	}

	private registerActions(): void {
		const that = this;
		this._register(registerAction2(class extends Action2 {
			constructor() {
				super({
					id: ToggleActivityBarVisibilityActionId,
					title: localize2('toggleActivityBar', "Toggle Activity Bar Visibility"),
				});
			}
			run(): Promise<void> {
				const value = that.configurationService.getValue(LayoutSettings.ACTIVITY_BAR_LOCATION) === ActivityBarPosition.HIDDEN ? that.getRememberedActivityBarVisiblePosition() : ActivityBarPosition.HIDDEN;
				return that.configurationService.updateValue(LayoutSettings.ACTIVITY_BAR_LOCATION, value);
			}
		}));
	}

	toJSON(): object {
		return {
			type: Parts.SIDEBAR_PART
		};
	}
}
