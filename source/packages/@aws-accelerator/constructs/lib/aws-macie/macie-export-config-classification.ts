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
import { Construct } from 'constructs';

const path = require('path');

/**
 * Initialized MacieExportConfigClassificationProps properties
 */
export interface MacieExportConfigClassificationProps {
  /**
   * Macie ExportConfigClassification repository bucket name
   */
  readonly bucketName: string;
  /**
   * Macie ExportConfigClassification repository bucket encryption key
   */
  readonly bucketKmsKey: cdk.aws_kms.IKey;
  /**
   * Bucket key prefix
   */
  readonly keyPrefix: string;
  /**
   * Custom resource lambda log group encryption key, when undefined default AWS managed key will be used
   */
  readonly logKmsKey?: cdk.aws_kms.IKey;
  /**
   * Custom resource lambda log retention in days
   */
  readonly logRetentionInDays: number;
  /**
   * Macie value for how frequently you want to publish the findings
   */
  readonly findingPublishingFrequency: 'FIFTEEN_MINUTES' | 'ONE_HOUR' | 'SIX_HOURS';

  /**
   * Macie value to determine if we publish classifications to Security Hub
   */
  readonly publishClassificationFindings: boolean;

  /**
   * Macie value to determine if we publish findings at all
   */
  readonly publishPolicyFindings: boolean;
}

/**
 * Aws MacieSession export configuration classification
 */
export class MacieExportConfigClassification extends Construct {
  public readonly id: string = '';

  constructor(scope: Construct, id: string, props: MacieExportConfigClassificationProps) {
    super(scope, id);

    const RESOURCE_TYPE = 'Custom::MaciePutClassificationExportConfiguration';

    const provider = cdk.CustomResourceProvider.getOrCreateProvider(this, RESOURCE_TYPE, {
      codeDirectory: path.join(__dirname, 'put-export-config-classification/dist'),
      runtime: cdk.CustomResourceProviderRuntime.NODEJS_18_X,
      policyStatements: [
        {
          Sid: 'MaciePutClassificationExportConfigurationTaskMacieActions',
          Effect: 'Allow',
          Action: [
            'macie2:EnableMacie',
            'macie2:GetClassificationExportConfiguration',
            'macie2:UpdateMacieSession',
            'macie2:GetMacieSession',
            'macie2:PutClassificationExportConfiguration',
            'macie2:PutFindingsPublicationConfiguration',
          ],
          Resource: '*',
        },
      ],
    });

    const resource = new cdk.CustomResource(this, 'Resource', {
      resourceType: RESOURCE_TYPE,
      serviceToken: provider.serviceToken,
      properties: {
        region: cdk.Stack.of(this).region,
        bucketName: props.bucketName,
        keyPrefix: props.keyPrefix,
        kmsKeyArn: props.bucketKmsKey.keyArn,
        findingPublishingFrequency: props.findingPublishingFrequency,
        publishClassificationFindings: props.publishClassificationFindings,
        publishPolicyFindings: props.publishPolicyFindings,
      },
    });

    /**
     * Singleton pattern to define the log group for the singleton function
     * in the stack
     */
    const stack = cdk.Stack.of(scope);
    const logGroup =
      (stack.node.tryFindChild(`${provider.node.id}LogGroup`) as cdk.aws_logs.LogGroup) ??
      new cdk.aws_logs.LogGroup(stack, `${provider.node.id}LogGroup`, {
        logGroupName: `/aws/lambda/${(provider.node.findChild('Handler') as cdk.aws_lambda.CfnFunction).ref}`,
        retention: props.logRetentionInDays,
        encryptionKey: props.logKmsKey,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    resource.node.addDependency(logGroup);

    this.id = resource.ref;
  }
}
