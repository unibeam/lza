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
import { BucketPrefix } from '@aws-accelerator/constructs';
import { snapShotTest } from '../snapshot-test';

const testNamePrefix = 'Construct(BucketPrefix): ';

//Initialize stack for snapshot test and resource configuration test
const stack = new cdk.Stack();

new BucketPrefix(stack, 'BucketPrefix', {
  source: { bucketName: `aws-accelerator-central-logs-bucket-${cdk.Aws.ACCOUNT_ID}-${cdk.Aws.REGION}` },
  bucketPrefixes: ['guardduty'],
  customResourceLambdaEnvironmentEncryptionKmsKey: new cdk.aws_kms.Key(stack, 'LambdaKey', {}),
  customResourceLambdaCloudWatchLogKmsKey: new cdk.aws_kms.Key(stack, 'CustomKey', {}),
  customResourceLambdaLogRetentionInDays: 3653,
  nagSuppressionPrefix: 'BucketPrefix/Resource/BucketPrefix',
});

/**
 * BucketPrefix construct test
 */
describe('BucketPrefix', () => {
  snapShotTest(testNamePrefix, stack);
});
