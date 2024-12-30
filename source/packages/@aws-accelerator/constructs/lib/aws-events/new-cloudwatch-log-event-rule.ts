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
import * as path from 'path';

export type cloudwatchExclusionProcessedItem = {
  account: string;
  region: string;
  excludeAll?: boolean;
  logGroupNames?: string[];
};

/**
 * Construction properties for CloudWatch Logs Creating account.
 */

export interface NewCloudWatchLogsEventProps {
  /**
   *
   * Log Destination Arn to which all the logs will get forwarded to
   */
  logDestinationArn: string;
  /**
   *
   * KMS key to encrypt the Lambda environment variables, when undefined default AWS managed key will be used
   */
  lambdaEnvKey?: cdk.aws_kms.IKey;
  /**
   *
   * KMS key to encrypt the Lambda environment variables, when undefined default AWS managed key will be used
   */
  logsKmsKey?: cdk.aws_kms.IKey;
  /**
   *
   * CloudWatch Retention in days from global config
   */
  logsRetentionInDaysValue: string;
  /**
   *
   * Subscription Filter Arn
   */
  subscriptionFilterRoleArn: string;
  /**
   *
   * AWS Partition where code is being executed
   */
  logArchiveAccountId: string;
  /**
   * Accelerator Prefix defaults to 'AWSAccelerator'.
   */
  acceleratorPrefix: string;
  /**
   * Use existing IAM roles for deployment.
   */
  useExistingRoles: boolean;
  /**
   * CloudWatch Logs exclusion setting
   */
  exclusionSetting?: cloudwatchExclusionProcessedItem;
}

/**
 * Class to configure CloudWatch event when new log group is created
 */
export class NewCloudWatchLogEvent extends Construct {
  constructor(scope: Construct, id: string, props: NewCloudWatchLogsEventProps) {
    super(scope, id);
    let LogSubscriptionRole: string;
    if (props.useExistingRoles) {
      LogSubscriptionRole = `arn:${cdk.Stack.of(this).partition}:iam::${cdk.Stack.of(this).account}:role/${
        props.acceleratorPrefix
      }LogReplicationRole-${cdk.Stack.of(this).region}`;
    } else {
      LogSubscriptionRole = props.subscriptionFilterRoleArn;
    }

    const newLogGroupRule = new cdk.aws_events.Rule(this, 'NewLogGroupCreatedRule', {
      eventPattern: {
        detailType: ['AWS API Call via CloudTrail'],
        source: ['aws.logs'],
        detail: {
          eventSource: ['logs.amazonaws.com'],
          eventName: ['CreateLogGroup'],
        },
      },
    });

    // Lambda function that sets expiration and puts subscription filter on
    const lambdaEnvironmentList:
      | {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          [key: string]: any;
        }[] = [
      { AcceleratorPrefix: props.acceleratorPrefix },
      { LogRetention: props.logsRetentionInDaysValue },
      { LogDestination: props.logDestinationArn },
      { LogSubscriptionRole: LogSubscriptionRole },
      { LogExclusion: JSON.stringify(props.exclusionSetting!) },
    ];

    if (props.logsKmsKey) {
      lambdaEnvironmentList.push({ LogKmsKeyArn: props.logsKmsKey.keyArn });
    }

    const lambdaEnvironment: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      [key: string]: any;
    } = {};

    for (const environmentVariable of lambdaEnvironmentList) {
      for (const [key, value] of Object.entries(environmentVariable)) {
        lambdaEnvironment[key] = value;
      }
    }

    const setLogRetentionSubscriptionFunction = new cdk.aws_lambda.Function(
      this,
      'SetLogRetentionSubscriptionFunction',
      {
        runtime: cdk.aws_lambda.Runtime.NODEJS_18_X,
        timeout: cdk.Duration.minutes(15),
        handler: 'index.handler',
        code: cdk.aws_lambda.Code.fromAsset(path.join(__dirname, 'put-subscription-policy/dist')),
        environmentEncryption: props.lambdaEnvKey,
        environment: lambdaEnvironment,
        initialPolicy: [
          new cdk.aws_iam.PolicyStatement({
            actions: [
              'logs:PutRetentionPolicy',
              'logs:AssociateKmsKey',
              'logs:DescribeLogGroups',
              'logs:DescribeSubscriptionFilters',
            ],
            resources: [
              `arn:${cdk.Stack.of(this).partition}:logs:${cdk.Stack.of(this).region}:${
                cdk.Stack.of(this).account
              }:log-group:*`,
            ],
          }),
          new cdk.aws_iam.PolicyStatement({
            actions: ['logs:PutSubscriptionFilter', 'logs:DeleteSubscriptionFilter'],
            resources: [
              `arn:${cdk.Stack.of(this).partition}:logs:${cdk.Stack.of(this).region}:${
                cdk.Stack.of(this).account
              }:log-group:*`,
              `arn:${cdk.Stack.of(this).partition}:logs:${cdk.Stack.of(this).region}:${
                props.logArchiveAccountId
              }:destination:*`,
            ],
          }),
        ],
      },
    );
    // set basic trigger with 5 retries
    newLogGroupRule.addTarget(
      new cdk.aws_events_targets.LambdaFunction(setLogRetentionSubscriptionFunction, { retryAttempts: 5 }),
    );
  }
}
