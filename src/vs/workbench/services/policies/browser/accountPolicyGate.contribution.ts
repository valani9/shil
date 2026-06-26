/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { AccountPolicyGateContribution } from './accountPolicyGateContribution.js';
import product from '../../../../platform/product/common/product.js';

// Shil: skip the account-policy gate notification ("Sign in to GitHub") —
// Shil is not GitHub's client. Keep the contribution for upstream OSS only.
if (product.nameShort === 'Code - OSS') {
	registerWorkbenchContribution2(AccountPolicyGateContribution.ID, AccountPolicyGateContribution, WorkbenchPhase.AfterRestored);
}
