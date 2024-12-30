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

import { chunkArray, getGlobalRegion } from '@aws-accelerator/utils/lib/common-functions';
import { throttlingBackOff } from '@aws-accelerator/utils/lib/throttle';
import { CloudFormationCustomResourceEvent } from '@aws-accelerator/utils/lib/common-types';
import * as AWS from 'aws-sdk';
AWS.config.logger = console;

/**
 * enable-detective - lambda handler
 *
 * @param event
 * @returns
 */
export async function handler(event: CloudFormationCustomResourceEvent): Promise<
  | {
      Status: string | undefined;
      StatusCode: number | undefined;
    }
  | undefined
> {
  const region = event.ResourceProperties['region'];
  const partition = event.ResourceProperties['partition'];
  const globalRegion = getGlobalRegion(partition);
  const chunkSize = process.env['CHUNK_SIZE'] ? parseInt(process.env['CHUNK_SIZE']) : 50;
  const organizationsClient = new AWS.Organizations({
    region: globalRegion,
    customUserAgent: process.env['SOLUTION_ID'],
  });
  const detectiveClient = new AWS.Detective({ region: region, customUserAgent: process.env['SOLUTION_ID'] });

  const graphArn = await getGraphArn(detectiveClient);

  let nextToken: string | undefined = undefined;

  switch (event.RequestType) {
    case 'Create':
    case 'Update':
      console.log('starting - CreateMembersCommand');
      const allAccounts: AWS.Detective.Account[] = [];

      do {
        const page = await throttlingBackOff(() =>
          organizationsClient.listAccounts({ NextToken: nextToken }).promise(),
        );
        for (const account of page.Accounts ?? []) {
          allAccounts.push({ AccountId: account.Id!, EmailAddress: account.Email! });
        }
        nextToken = page.NextToken;
      } while (nextToken);

      const chunkedAccountsForCreate = chunkArray(allAccounts, chunkSize);

      for (const accounts of chunkedAccountsForCreate) {
        console.log(`Initiating createMembers request for ${accounts.length} accounts`);
        await throttlingBackOff(() =>
          detectiveClient.createMembers({ GraphArn: graphArn!, Accounts: accounts }).promise(),
        );
      }

      return { Status: 'Success', StatusCode: 200 };

    case 'Delete':
      const existingMemberAccountIds: string[] = [];
      nextToken = undefined;
      do {
        const page = await throttlingBackOff(() =>
          detectiveClient.listMembers({ GraphArn: graphArn!, NextToken: nextToken }).promise(),
        );
        for (const member of page.MemberDetails ?? []) {
          console.log(member);
          existingMemberAccountIds.push(member.AccountId!);
        }
        nextToken = page.NextToken;
      } while (nextToken);

      if (existingMemberAccountIds.length > 0) {
        const chunkedAccountsForDelete = chunkArray(existingMemberAccountIds, chunkSize);

        for (const existingMemberAccountIdBatch of chunkedAccountsForDelete) {
          console.log(`Initiating deleteMembers request for ${existingMemberAccountIdBatch.length} accounts`);
          await throttlingBackOff(() =>
            detectiveClient.deleteMembers({ AccountIds: existingMemberAccountIdBatch, GraphArn: graphArn! }).promise(),
          );
        }
      }

      return { Status: 'Success', StatusCode: 200 };
  }
}

async function getGraphArn(detectiveClient: AWS.Detective): Promise<string | undefined> {
  const response = await throttlingBackOff(() => detectiveClient.listGraphs({}).promise());
  console.log(response);
  if (response.GraphList!.length === 0) {
    throw new Error(
      'Could not find graph. It does not look like this account has been set as the delegated administrator for AWS Detective.',
    );
  }
  return response.GraphList!.length === 1 ? response.GraphList![0].Arn : undefined;
}
