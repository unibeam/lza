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

import { describe } from '@jest/globals';
import { AcceleratorStage } from '../lib/accelerator-stage';
import { snapShotTest } from './snapshot-test';
import { Create } from './accelerator-test-helpers';

const testNamePrefix = 'Construct(NetworkAssociationsStack): ';

describe('NetworkAssociationsStack', () => {
  snapShotTest(testNamePrefix, Create.stackProvider(`Network-us-east-1`, AcceleratorStage.NETWORK_ASSOCIATIONS));
});

describe('NoVpcFlowLogStack', () => {
  snapShotTest(
    testNamePrefix,
    Create.stackProvider(`Network-us-east-1`, [
      AcceleratorStage.NETWORK_ASSOCIATIONS,
      'aws',
      'us-east-1',
      'all-enabled-ou-targets',
    ]),
  );
});
