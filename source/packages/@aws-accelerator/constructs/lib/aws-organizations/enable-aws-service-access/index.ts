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

import { throttlingBackOff } from '@aws-accelerator/utils/lib/throttle';
import { getGlobalRegion } from '@aws-accelerator/utils/lib/common-functions';
import { CloudFormationCustomResourceEvent } from '@aws-accelerator/utils/lib/common-types';
import * as AWS from 'aws-sdk';
AWS.config.logger = console;

/**
 * enable-aws-service-access - lambda handler
 *
 * @param event
 * @returns
 */
export async function handler(event: CloudFormationCustomResourceEvent): Promise<
  | {
      PhysicalResourceId: string | undefined;
      Status: string;
    }
  | undefined
> {
  const partition = event.ResourceProperties['partition'];
  const servicePrincipal: string = event.ResourceProperties['servicePrincipal'];
  const solutionId = process.env['SOLUTION_ID'];
  const globalRegion = getGlobalRegion(partition);
  const organizationsClient = new AWS.Organizations({ customUserAgent: solutionId, region: globalRegion });

  switch (event.RequestType) {
    case 'Create':
    case 'Update':
      await throttlingBackOff(() =>
        organizationsClient.enableAWSServiceAccess({ ServicePrincipal: servicePrincipal }).promise(),
      );

      return {
        PhysicalResourceId: servicePrincipal,
        Status: 'SUCCESS',
      };

    case 'Delete':
      await throttlingBackOff(() =>
        organizationsClient.disableAWSServiceAccess({ ServicePrincipal: servicePrincipal }).promise(),
      );
      return {
        PhysicalResourceId: event.PhysicalResourceId,
        Status: 'SUCCESS',
      };
  }
}
