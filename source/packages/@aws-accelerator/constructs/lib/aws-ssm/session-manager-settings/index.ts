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
import { CloudFormationCustomResourceEvent } from '@aws-accelerator/utils/lib/common-types';
import {
  CreateDocumentCommand,
  CreateDocumentCommandInput,
  DescribeDocumentCommand,
  DuplicateDocumentContent,
  InvalidDocument,
  SSMClient,
  UpdateDocumentCommand,
  UpdateDocumentCommandInput,
} from '@aws-sdk/client-ssm';
import { setRetryStrategy } from '@aws-accelerator/utils/lib/common-functions';

const documentName = 'SSM-SessionManagerRunShell';

export async function handler(event: CloudFormationCustomResourceEvent): Promise<
  | {
      PhysicalResourceId: string | undefined;
      Status: string;
    }
  | undefined
> {
  const s3BucketName: string = event.ResourceProperties['s3BucketName'];
  const s3KeyPrefix: string = event.ResourceProperties['s3KeyPrefix'];
  const s3EncryptionEnabled: boolean = event.ResourceProperties['s3EncryptionEnabled'] === 'true';
  const cloudWatchLogGroupName: string = event.ResourceProperties['cloudWatchLogGroupName'];
  const cloudWatchEncryptionEnabled: boolean = event.ResourceProperties['cloudWatchEncryptionEnabled'] === 'true';
  const kmsKeyId: string = event.ResourceProperties['kmsKeyId'];
  const solutionId = process.env['SOLUTION_ID'];

  const ssm = new SSMClient({ customUserAgent: solutionId, retryStrategy: setRetryStrategy() });

  switch (event.RequestType) {
    case 'Create':
    case 'Update':
      // Based on doc: https://docs.aws.amazon.com/systems-manager/latest/userguide/getting-started-configure-preferences-cli.html
      const settings = {
        schemaVersion: '1.0',
        description: 'Document to hold regional settings for Session Manager',
        sessionType: 'Standard_Stream',
        inputs: {
          cloudWatchEncryptionEnabled,
          cloudWatchLogGroupName,
          kmsKeyId,
          s3BucketName,
          s3EncryptionEnabled,
          s3KeyPrefix: s3KeyPrefix ?? '',
          runAsEnabled: false,
          runAsDefaultUser: '',
        },
      };
      try {
        await throttlingBackOff(() => ssm.send(new DescribeDocumentCommand({ Name: documentName })));
        const updateDocumentRequest: UpdateDocumentCommandInput = {
          Content: JSON.stringify(settings),
          Name: documentName,
          DocumentVersion: '$LATEST',
        };
        console.log('Update SSM Document Request: ', updateDocumentRequest);
        await throttlingBackOff(() => ssm.send(new UpdateDocumentCommand(updateDocumentRequest)));
        console.log('Update SSM Document Success');
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        if (e instanceof DuplicateDocumentContent) {
          console.log(`SSM Document is Already latest :${documentName}`);
        } else if (e instanceof InvalidDocument) {
          const createDocumentRequest: CreateDocumentCommandInput = {
            Content: JSON.stringify(settings),
            Name: documentName,
            DocumentType: `Session`,
          };
          console.log('Create SSM Document Request: ', createDocumentRequest);
          await throttlingBackOff(() => ssm.send(new CreateDocumentCommand(createDocumentRequest)));
          console.log('Create SSM Document Success');
        } else {
          throw new Error(`Error while updating SSM Document :${documentName}. Received: ${JSON.stringify(e)}`);
        }
      }

      return {
        PhysicalResourceId: 'session-manager-settings',
        Status: 'SUCCESS',
      };

    case 'Delete':
      // Do Nothing
      return {
        PhysicalResourceId: event.PhysicalResourceId,
        Status: 'SUCCESS',
      };
  }
}
