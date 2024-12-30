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
import { Inventory } from '../../lib/aws-ssm/inventory';
import { snapShotTest } from '../snapshot-test';

const testNamePrefix = '../snapshot-test';

const stack = new cdk.Stack();

new Inventory(stack, 'Inventory', {
  bucketName: 'central-log-bucket',
  bucketRegion: 'us-east-1',
  accountId: '99999999999',
  prefix: 'test',
});

describe('Inventory', () => {
  snapShotTest(testNamePrefix, stack);
});
