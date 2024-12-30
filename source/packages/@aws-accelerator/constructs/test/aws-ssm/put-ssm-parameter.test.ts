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

import { PutSsmParameter } from '../../lib/aws-ssm/put-ssm-parameter';
import { snapShotTest } from '../snapshot-test';

const testNamePrefix = 'Construct(SsmParameter): ';

//Initialize stack for snapshot test and resource configuration test
const stack = new cdk.Stack();

new PutSsmParameter(stack, 'SsmParameter', {
  accountIds: ['111111111111', '222222222222'],
  region: 'us-east-1',
  roleName: `AWSAccelerator-VpcPeeringRole-222222222222`,
  parameters: [
    {
      name: `/accelerator/network/vpcPeering/name/id`,
      value: 'vp-123123123',
    },
  ],
  kmsKey: new cdk.aws_kms.Key(stack, 'key'),
  logRetentionInDays: 3653,
  invokingAccountId: '333333333333',
  acceleratorPrefix: 'AWSAccelerator',
});

/**
 * SsmParameter construct test
 */
describe('SsmParameter', () => {
  snapShotTest(testNamePrefix, stack);
});
