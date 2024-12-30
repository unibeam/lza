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

import { pascalCase } from 'change-case';
import path from 'path';
/**
 * Construction properties for an S3 Bucket replication.
 */
export interface BucketReplicationProps {
  source?: {
    /**
     * Source bucket object
     *
     * Source bucket object is must when source bucket name wasn't provided
     */
    bucket?: cdk.aws_s3.IBucket;
    /**
     * Source bucket name
     *
     * Source bucket name is must when source bucket object wasn't provided
     */
    bucketName?: string;
    /**
     * Filter to limit the scope of this rule to a single prefix.
     */
    prefix?: string;
  };
  destination: {
    /**
     * Destination bucket name
     */
    bucketName: string;
    /**
     * Destination bucket account Id
     */
    accountId: string;
    /**
     * Destination bucket key arn
     */
    keyArn?: string;
  };
  /**
   * Custom resource lambda log group encryption key, when undefined default AWS managed key will be used
   */
  readonly kmsKey?: cdk.aws_kms.IKey;
  /**
   * Custom resource lambda log retention in days
   */
  readonly logRetentionInDays: number;
  /**
   * Use existing IAM resources
   */
  readonly useExistingRoles: boolean;
  /**
   * Accelerator prefix, defaults to 'AWSAccelerator'
   */
  readonly acceleratorPrefix: string;
}

/**
 * Class to configure S3 bucket replication
 */
export class BucketReplication extends Construct {
  private readonly sourceBucket: cdk.aws_s3.IBucket;
  private readonly destinationBucket: cdk.aws_s3.IBucket;
  constructor(scope: Construct, id: string, props: BucketReplicationProps) {
    super(scope, id);

    if (props.source!.bucket && props.source!.bucketName) {
      throw new Error('Source bucket or source bucketName (only one property) should be defined.');
    }

    if (!props.source!.bucket && !props.source!.bucketName) {
      throw new Error('Source bucket or source bucketName property must be defined when using bucket replication.');
    }

    if (props.source!.bucketName) {
      this.sourceBucket = cdk.aws_s3.Bucket.fromBucketName(
        this,
        `${pascalCase(props.source!.bucketName)}`,
        props.source!.bucketName,
      );
    } else {
      this.sourceBucket = props.source!.bucket!;
    }

    this.destinationBucket = cdk.aws_s3.Bucket.fromBucketName(
      this,
      `${pascalCase(props.destination.bucketName)}`,
      props.destination.bucketName,
    );

    if (this.sourceBucket.encryptionKey && !props.destination.keyArn) {
      throw new Error('Destination bucket key arn property require when source bucket have server side encryption.');
    }

    const RESOURCE_TYPE = 'Custom::S3PutBucketReplication';

    const provider = cdk.CustomResourceProvider.getOrCreateProvider(this, RESOURCE_TYPE, {
      codeDirectory: path.join(__dirname, 'put-bucket-replication/dist'),
      runtime: cdk.CustomResourceProviderRuntime.NODEJS_18_X,
      policyStatements: [
        {
          Sid: 'S3PutReplicationConfigurationTaskActions',
          Effect: 'Allow',
          Action: [
            'iam:PassRole',
            's3:PutLifecycleConfiguration',
            's3:PutReplicationConfiguration',
            's3:PutBucketVersioning',
          ],
          Resource: '*',
        },
      ],
    });

    const resource = new cdk.CustomResource(this, 'Resource', {
      resourceType: RESOURCE_TYPE,
      serviceToken: provider.serviceToken,
      properties: {
        replicationRoleArn: this.createReplicationRole(
          props.destination.bucketName,
          props.destination.keyArn,
          props.useExistingRoles,
          props.acceleratorPrefix,
        ),
        sourceBucketName: this.sourceBucket.bucketName,
        prefix: props.source!.prefix ?? '',
        destinationBucketArn: this.destinationBucket.bucketArn,
        destinationBucketKeyArn: props.destination.keyArn ?? '',
        destinationAccountId: props.destination.accountId,
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
        encryptionKey: props.kmsKey,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    resource.node.addDependency(logGroup);
  }
  private createReplicationRole(
    destinationBucketName: string,
    destinationKeyArn: string | undefined,
    useExistingRoles: boolean,
    acceleratorPrefix: string,
  ) {
    if (useExistingRoles) {
      return `arn:${cdk.Stack.of(this).partition}:iam::${
        cdk.Stack.of(this).account
      }:role/${acceleratorPrefix}S3ReplicationRole`;
    }
    //
    // Create role for replication
    const replicationRole = new cdk.aws_iam.Role(this, `${pascalCase(destinationBucketName)}-ReplicationRole`, {
      assumedBy: new cdk.aws_iam.ServicePrincipal('s3.amazonaws.com'),
      path: '/service-role/',
    });

    const replicationRolePolicies: cdk.aws_iam.PolicyStatement[] = [
      new cdk.aws_iam.PolicyStatement({
        resources: [this.sourceBucket.bucketArn, this.sourceBucket.arnForObjects('*')],
        actions: [
          's3:GetObjectLegalHold',
          's3:GetObjectRetention',
          's3:GetObjectVersion',
          's3:GetObjectVersionAcl',
          's3:GetObjectVersionForReplication',
          's3:GetObjectVersionTagging',
          's3:GetReplicationConfiguration',
          's3:ListBucket',
          's3:ReplicateDelete',
          's3:ReplicateObject',
          's3:ReplicateTags',
        ],
      }),
      new cdk.aws_iam.PolicyStatement({
        resources: [this.destinationBucket.arnForObjects('*')],
        actions: [
          's3:GetBucketVersioning',
          's3:GetObjectVersionTagging',
          's3:ObjectOwnerOverrideToBucketOwner',
          's3:PutBucketVersioning',
          's3:ReplicateDelete',
          's3:ReplicateObject',
          's3:ReplicateTags',
        ],
      }),
    ];

    if (this.sourceBucket.encryptionKey) {
      replicationRolePolicies.push(
        new cdk.aws_iam.PolicyStatement({
          resources: [this.sourceBucket.encryptionKey.keyArn],
          actions: ['kms:Decrypt'],
        }),
      );
    }

    if (destinationKeyArn) {
      replicationRolePolicies.push(
        new cdk.aws_iam.PolicyStatement({
          resources: [destinationKeyArn],
          actions: ['kms:Encrypt'],
        }),
      );
    }

    replicationRolePolicies.forEach(item => {
      replicationRole.addToPolicy(item);
    });

    return replicationRole.roleArn;
  }
}
