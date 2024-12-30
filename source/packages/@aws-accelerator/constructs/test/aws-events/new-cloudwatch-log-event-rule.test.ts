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
import { NewCloudWatchLogEvent } from '../../lib/aws-events/new-cloudwatch-log-event-rule';
import { snapShotTest } from '../snapshot-test';
import { describe } from '@jest/globals';

const testNamePrefix = 'Construct(NewCloudWatchLogEvent): ';

//Initialize stack for snapshot test and resource configuration test
const stack = new cdk.Stack();

new NewCloudWatchLogEvent(stack, 'NewCloudWatchLogEvent', {
  logsKmsKey: new cdk.aws_kms.Key(stack, 'CustomKey', {}),
  lambdaEnvKey: new cdk.aws_kms.Key(stack, 'CustomLambdaKey', {}),
  logDestinationArn: 'LogRetentionArn',
  logsRetentionInDaysValue: '731',
  subscriptionFilterRoleArn: 'testString',
  logArchiveAccountId: 'some-account-id',
  acceleratorPrefix: 'AWSAccelerator',
  useExistingRoles: false,
});

new NewCloudWatchLogEvent(stack, 'NewCloudWatchLogEventExistingIam', {
  logsKmsKey: new cdk.aws_kms.Key(stack, 'CustomKeyExistingIam', {}),
  lambdaEnvKey: new cdk.aws_kms.Key(stack, 'CustomLambdaKeyExistingIam', {}),
  logDestinationArn: 'LogRetentionArn',
  logsRetentionInDaysValue: '731',
  subscriptionFilterRoleArn: 'testString',
  logArchiveAccountId: 'some-account-id',
  acceleratorPrefix: 'AWSAccelerator',
  useExistingRoles: true,
});

/**
 * CloudWatchDestination construct test
 */
describe('NewCloudWatchLogEvent', () => {
  snapShotTest(testNamePrefix, stack);
});
