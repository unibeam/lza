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
import { setRetryStrategy } from '@aws-accelerator/utils/lib/common-functions';
import { CloudFormationCustomResourceEvent } from '@aws-accelerator/utils/lib/common-types';
import { SSMClient, DescribeDocumentPermissionCommand, ModifyDocumentPermissionCommand } from '@aws-sdk/client-ssm';

/**
 * share-document - lambda handler
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
  const name = event.ResourceProperties['name'];
  const accountIds: string[] = event.ResourceProperties['accountIds'];
  const solutionId = process.env['SOLUTION_ID'];

  const ssmClient = new SSMClient({ customUserAgent: solutionId, retryStrategy: setRetryStrategy() });

  console.log('DescribeDocumentPermissionCommand:');
  const documentPermission: string[] = [];
  let nextToken: string | undefined = undefined;
  // there is no paginator for DescribeDocumentPermissionCommand, so we need to loop through all pages.
  do {
    const page = await throttlingBackOff(() =>
      ssmClient.send(new DescribeDocumentPermissionCommand({ Name: name, PermissionType: 'Share' })),
    );

    for (const accountId of page.AccountIds ?? []) {
      documentPermission.push(accountId);
    }
    nextToken = page.NextToken;
  } while (nextToken);

  console.log(documentPermission);

  switch (event.RequestType) {
    case 'Create':
    case 'Update':
      const accountIdsToAdd: string[] = [];
      const accountIdsToRemove: string[] = [];

      // Identify accounts to add
      accountIds.forEach(accountId => {
        if (!documentPermission.includes(accountId)) {
          accountIdsToAdd.push(accountId);
        }
      });

      // Identify accounts to remove
      documentPermission.forEach(accountId => {
        if (!accountIds.includes(accountId)) {
          accountIdsToRemove.push(accountId);
        }
      });

      console.log(`accountIdsToAdd: ${accountIdsToAdd}`);
      console.log(`accountIdsToRemove: ${accountIdsToRemove}`);

      // api call can only process 20 accounts
      // in the AccountIdsToAdd and AccountIdsToRemove
      // on each call

      let maxItems = accountIdsToAdd.length;
      if (accountIdsToRemove.length > maxItems) {
        maxItems = accountIdsToRemove.length;
      }
      let counter = 0;
      while (counter <= maxItems) {
        const itemsToAdd = accountIdsToAdd.slice(counter, counter + 20);
        const itemsToRemove = accountIdsToRemove.slice(counter, counter + 20);

        console.log('ModifyDocumentPermissionCommand:');
        const response = await throttlingBackOff(() =>
          ssmClient.send(
            new ModifyDocumentPermissionCommand({
              Name: name,
              PermissionType: 'Share',
              AccountIdsToAdd: itemsToAdd,
              AccountIdsToRemove: itemsToRemove,
            }),
          ),
        );
        console.log(JSON.stringify(response));
        counter = counter + 20;
      }

      return {
        PhysicalResourceId: 'share-document',
        Status: 'SUCCESS',
      };

    case 'Delete':
      console.log('Start un-sharing the document');
      console.log('Following accounts to be un-share');
      console.log(documentPermission);

      let deleteCounter = 0;
      while (deleteCounter <= documentPermission.length) {
        const itemsToDelete = documentPermission.slice(deleteCounter, deleteCounter + 20);

        // Remove sharing
        await throttlingBackOff(() =>
          ssmClient.send(
            new ModifyDocumentPermissionCommand({
              Name: name,
              PermissionType: 'Share',
              AccountIdsToRemove: itemsToDelete,
            }),
          ),
        );
        deleteCounter = deleteCounter + 20;
      }
      return {
        PhysicalResourceId: event.PhysicalResourceId,
        Status: 'SUCCESS',
      };
  }
}
