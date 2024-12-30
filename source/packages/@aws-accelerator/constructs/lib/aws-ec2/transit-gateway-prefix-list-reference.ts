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

export interface TransitGatewayPrefixListReferenceProps {
  /**
   * The prefix list ID to reference
   */
  readonly prefixListId: string;
  /**
   * Custom resource lambda log group encryption key, when undefined default AWS managed key will be used
   */
  readonly logGroupKmsKey?: cdk.aws_kms.IKey;
  /**
   * Custom resource lambda log retention in days
   */
  readonly logRetentionInDays: number;
  /**
   * The ID of the transit gateway route table.
   */
  readonly transitGatewayRouteTableId: string;
  /**
   * Determines if route is blackholed.
   */
  readonly blackhole?: boolean;
  /**
   * Owning account ID for cross-account TGW associations
   */
  readonly owningAccountId?: string;
  /**
   * Owning region for cross-account TGW associations
   */
  readonly owningRegion?: string;
  /**
   * Role name for cross-account TGW associations
   */
  readonly roleName?: string;
  /**
   * The identifier of the Transit Gateway Attachment
   *
   */
  readonly transitGatewayAttachmentId?: string;
}

export class TransitGatewayPrefixListReference extends cdk.Resource {
  public readonly id: string;

  constructor(scope: Construct, id: string, props: TransitGatewayPrefixListReferenceProps) {
    super(scope, id);

    const policyStatements = [
      {
        Sid: 'AllowModifyTgwReferences',
        Effect: 'Allow',
        Action: [
          'ec2:CreateTransitGatewayPrefixListReference',
          'ec2:ModifyTransitGatewayPrefixListReference',
          'ec2:DeleteTransitGatewayPrefixListReference',
        ],
        Resource: '*',
      },
    ];

    if (props.roleName) {
      policyStatements.push({
        Sid: 'AssumeRole',
        Effect: 'Allow',
        Action: ['sts:AssumeRole'],
        Resource: `arn:${this.stack.partition}:iam::*:role/${props.roleName}`,
      });
    }

    const provider = cdk.CustomResourceProvider.getOrCreateProvider(this, 'Custom::TransitGatewayPrefixListReference', {
      codeDirectory: path.join(__dirname, 'transit-gateway-prefix-list-reference/dist'),
      runtime: cdk.CustomResourceProviderRuntime.NODEJS_18_X,
      policyStatements,
    });

    const resource = new cdk.CustomResource(this, 'Resource', {
      resourceType: 'Custom::TransitGatewayPrefixListReference',
      serviceToken: provider.serviceToken,
      properties: {
        prefixListReference: {
          PrefixListId: props.prefixListId,
          TransitGatewayRouteTableId: props.transitGatewayRouteTableId,
          Blackhole: props.blackhole,
          TransitGatewayAttachmentId: props.transitGatewayAttachmentId,
        },
        owningAccountId: props.owningAccountId,
        owningRegion: props.owningRegion,
        roleName: props.roleName,
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
        encryptionKey: props.logGroupKmsKey,
        removalPolicy: cdk.RemovalPolicy.DESTROY,
      });
    resource.node.addDependency(logGroup);

    this.id = resource.ref;
  }
}
