/**
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Licensed under the Apache License, Version 2.0 (the "License"). You may not use this file except in compliance
 *  with the License. A copy of the License is located at
 *
 *      http://www.apache.org/licenses/LICENSE-2.0
 *
 *  or in the 'license' file accompanying this file. This file is distributed on an 'AS IS' BASIS, WITHOUT WARRANTIES
 *  OR CONDITIONS OF ANY KIND, express or implied. See the License for the specific language governing permissions
 *  and limitations under the License.
 */

import * as cdk from 'aws-cdk-lib';
import {
  IdentityCenterGetPermissionRoleArn,
  IdentityCenterGetPermissionRoleArnProvider,
} from '../../lib/aws-identity-center/identity-center-get-permission-set-role-arn';
import { snapShotTest } from '../snapshot-test';
import { describe } from '@jest/globals';
const testNamePrefix = 'Construct(IdentityCenterGetPermissionRoleArn): ';

//Initialize stack for snapshot test and resource configuration test
const stack = new cdk.Stack();

const provider = new IdentityCenterGetPermissionRoleArnProvider(stack, 'IdentityCenterGetPermissionRoleArnProvider');
const serviceToken = provider.serviceToken;

new IdentityCenterGetPermissionRoleArn(stack, 'IdentityCenterGetPermissionRoleArn', {
  permissionSetName: 'Test',
  accountId: '111111111111',
  serviceToken: serviceToken,
});

/**
 * IdentityCenterOrganizationAdminAccount construct test
 */
describe('IdentityCenterGetPermissionRoleArn', () => {
  snapShotTest(testNamePrefix, stack);
});
