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
import * as AWS from 'aws-sdk';
AWS.config.logger = console;

/**
 * put-bucket-prefix - lambda handler
 *
 * @param event
 * @returns
 */
export async function handler(event: CloudFormationCustomResourceEvent): Promise<
  | {
      PhysicalResourceId: string | undefined;
      Status: string | undefined;
    }
  | undefined
> {
  const sourceBucketName: string = event.ResourceProperties['sourceBucketName'];
  const sourceBucketKeyArn: string = event.ResourceProperties['sourceBucketKeyArn'];
  const bucketPrefixes: string[] = event.ResourceProperties['bucketPrefixes'];
  const solutionId = process.env['SOLUTION_ID'];
  const s3Client = new AWS.S3({ customUserAgent: solutionId });

  switch (event.RequestType) {
    case 'Create':
    case 'Update':
      for (const prefix of bucketPrefixes) {
        console.log(`starting - check bucket prefix for ${prefix}`);
        const listObjectsResponse = await throttlingBackOff(() =>
          s3Client
            .listObjectsV2({
              Bucket: sourceBucketName,
              Prefix: prefix + '/',
              MaxKeys: 1,
              Delimiter: '/',
            })
            .promise(),
        );
        if (!('Contents' in listObjectsResponse) || listObjectsResponse.Contents?.length === 0) {
          console.log(`starting - create bucket prefix for ${prefix}`);
          await throttlingBackOff(() =>
            s3Client
              .putObject({
                Bucket: sourceBucketName,
                Key: prefix + '/',
                ServerSideEncryption: 'aws:kms',
                SSEKMSKeyId: sourceBucketKeyArn,
              })
              .promise(),
          );
        }
      }
      return {
        PhysicalResourceId: `s3-prefix-${sourceBucketName}`,
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
