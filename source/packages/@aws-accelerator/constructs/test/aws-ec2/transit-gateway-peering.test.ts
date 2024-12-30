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
import { TransitGatewayPeering } from '../../lib/aws-ec2/transit-gateway-peering';
import { snapShotTest } from '../snapshot-test';

const testNamePrefix = 'Construct(TransitGatewayPrefixListReference): ';

//Initialize stack for snapshot test and resource configuration test
const stack = new cdk.Stack();

new TransitGatewayPeering(stack, 'TransitGatewayPeering', {
  accepter: {
    accountId: stack.account,
    accountAccessRoleName: 'ABC',
    region: 'us-west-2',
    transitGatewayName: 'Network-Main-Tgw',
    transitGatewayId: 'tgw-0001',
    transitGatewayRouteTableId: 'rt-001',
    autoAccept: true,
    applyTags: true,
  },
  requester: {
    accountName: 'SharedServices',
    principals: ['111111111111'],
    transitGatewayId: 'tgw-0002',
    transitGatewayName: 'SharedServices-TGW',
    transitGatewayRouteTableId: 'tgw-0002',
    tags: [{ key: 'Name', value: 'SharedServices-And-Network-Main-Peering' }],
  },
  customLambdaLogKmsKey: new cdk.aws_kms.Key(stack, 'TestKms', {}),
  logRetentionInDays: 3653,
});

/**
 * Transit gateway peering configuration construct test
 */
describe('TransitGatewayPeering', () => {
  snapShotTest(testNamePrefix, stack);
});
