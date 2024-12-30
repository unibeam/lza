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
import { pascalCase } from 'change-case';
import { Construct } from 'constructs';
import * as path from 'path';
import {
  AcceleratorStack,
  AcceleratorStackProps,
  AcceleratorKeyType,
  NagSuppressionRuleIds,
} from './accelerator-stack';
import {
  AppConfigItem,
  VpcConfig,
  VpcTemplatesConfig,
  ApplicationLoadBalancerListenerConfig,
  TargetGroupItemConfig,
  LaunchTemplateConfig,
  AutoScalingConfig,
  NetworkLoadBalancerConfig,
  ApplicationLoadBalancerConfig,
} from '@aws-accelerator/config';
import {
  TargetGroup,
  NetworkLoadBalancer,
  ApplicationLoadBalancer,
  LaunchTemplate,
  AutoscalingGroup,
} from '@aws-accelerator/constructs';
import { SsmResourceType } from '@aws-accelerator/utils/lib/ssm-parameter-path';

export type PrivateIpAddressConfig = {
  primary: boolean | undefined;
  privateIpAddress: string | undefined;
};
export type NetworkInterfaceItemConfig = {
  associateCarrierIpAddress: boolean | undefined;
  associateElasticIp: boolean | undefined;
  associatePublicIpAddress: boolean | undefined;
  deleteOnTermination: boolean | undefined;
  description: string | undefined;
  deviceIndex: number | undefined;
  groups: string[] | undefined;
  interfaceType: string | undefined;
  networkCardIndex: number | undefined;
  networkInterfaceId: string | undefined;
  privateIpAddress: string | undefined;
  secondaryPrivateIpAddressCount: number | undefined;
  sourceDestCheck: boolean | undefined;
  subnetId: string | undefined;
  privateIpAddresses: PrivateIpAddressConfig[] | undefined;
};
export type EbsProperty = {
  deleteOnTermination?: boolean;
  encrypted?: boolean;
  iops?: number;
  kmsKeyId?: string;
  snapshotId?: string;
  throughput?: number;
  volumeSize?: number;
  volumeType?: string;
};

export type BlockDeviceMappingItem = {
  deviceName: string;
  ebs?: EbsProperty;
};
export type TargetGroupItem = {
  name: string;
  targetGroup: TargetGroup;
};

export type AlbListenerConfig = {
  name: string;
  port: number;
  protocol: 'HTTP' | 'HTTPS';
  type: 'fixed-response' | 'forward' | 'redirect';
  certificate: string | undefined;
  sslPolicy?: string;
  targetGroup: string;
  fixedResponseConfig?: {
    messageBody?: string;
    contentType?: string;
    statusCode: string;
  };
  forwardConfig?: {
    targetGroupStickinessConfig?: {
      durationSeconds?: number;
      enabled?: boolean;
    };
  };
  order?: number;
  redirectConfig?: {
    statusCode?: string;
    host?: string;
    path?: string;
    port?: number;
    protocol?: string;
    query?: string;
  };
};
export interface ApplicationStackProps extends AcceleratorStackProps {
  readonly appConfigItem: AppConfigItem;
}

export class ApplicationsStack extends AcceleratorStack {
  private securityGroupMap: Map<string, string>;
  private subnetMap: Map<string, string>;
  private vpcMap: Map<string, string>;
  constructor(scope: Construct, id: string, props: ApplicationStackProps) {
    super(scope, id, props);
    this.props = props;
    const allVpcItems = [...props.networkConfig.vpcs, ...(props.networkConfig.vpcTemplates ?? [])] ?? [];
    const allAppConfigs: AppConfigItem[] = props.customizationsConfig.applications ?? [];
    const elbLogsBucketName = this.getElbLogsBucketName();

    // Set initial private properties
    [this.securityGroupMap, this.subnetMap, this.vpcMap] = this.setInitialMaps(allVpcItems, allAppConfigs);

    const lambdaKey = this.getAcceleratorKey(AcceleratorKeyType.LAMBDA_KEY);

    const cloudwatchKey = this.getAcceleratorKey(AcceleratorKeyType.CLOUDWATCH_KEY);

    //Create application config resources
    this.createApplicationConfigResources(
      props.appConfigItem,
      { securityGroupMap: this.securityGroupMap, subnetMap: this.subnetMap, vpcMap: this.vpcMap },
      props.configDirPath,
      allVpcItems,
      elbLogsBucketName,
      { key: cloudwatchKey, logRetentionInDays: this.props.globalConfig.cloudwatchLogRetentionInDays },
      lambdaKey,
    );

    // Create SSM parameters
    this.createSsmParameters();

    //
    // Create NagSuppressions
    //
    this.addResourceSuppressionsByPath();

    this.logger.info('Completed stack synthesis');
  }

  /**
   * Set security group, subnet, and VPC maps for this stack's account and region
   * @param props ApplicationStackProps
   * @returns Map of security group, subnet and VPC
   */
  private setInitialMaps(
    allVpcItems: (VpcConfig | VpcTemplatesConfig)[],
    allAppConfigs: AppConfigItem[],
  ): Map<string, string>[] {
    let securityGroupMap = new Map<string, string>();
    let subnetMap = new Map<string, string>();
    let vpcMap = new Map<string, string>();

    for (const appConfigItem of allAppConfigs) {
      [vpcMap, subnetMap, securityGroupMap] = this.setInitialMapProcessApp(
        appConfigItem,
        allVpcItems,
        vpcMap,
        subnetMap,
        securityGroupMap,
      );
    }
    return [securityGroupMap, subnetMap, vpcMap];
  }
  private setInitialMapProcessApp(
    appConfigItem: AppConfigItem,
    allVpcItems: (VpcConfig | VpcTemplatesConfig)[],
    vpcMap: Map<string, string>,
    subnetMap: Map<string, string>,
    securityGroupMap: Map<string, string>,
  ) {
    for (const vpcItem of allVpcItems) {
      //only process items in the same vpc
      if (vpcItem.name === appConfigItem.vpc) {
        [vpcMap, subnetMap, securityGroupMap] = this.setInitialMapProcessAppVpcItem(
          vpcItem,
          vpcMap,
          subnetMap,
          securityGroupMap,
        );
      }
    }
    return [vpcMap, subnetMap, securityGroupMap];
  }

  /**
   * Function to get Account IDs where VPC is created and subnets are shared to.
   * @param vpcItem
   * @returns
   */
  private getVpcAccountIdsWithShared(vpcItem: VpcConfig | VpcTemplatesConfig): string[] {
    const vpcAccountIds = this.getVpcAccountIds(vpcItem);
    const sharedSubnets = vpcItem.subnets ? vpcItem.subnets.filter(subnet => subnet.shareTargets) : [];
    for (const subnetItem of sharedSubnets) {
      const subnetAccountIds = this.getAccountIdsFromShareTarget(subnetItem.shareTargets!);
      subnetAccountIds.forEach(accountId => {
        if (!vpcAccountIds.includes(accountId)) {
          vpcAccountIds.push(accountId);
        }
      });
    }
    return vpcAccountIds;
  }

  private setInitialMapProcessAppVpcItem(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    vpcMap: Map<string, string>,
    subnetMap: Map<string, string>,
    securityGroupMap: Map<string, string>,
  ) {
    // Get account IDs
    const vpcAccountIds = this.getVpcAccountIdsWithShared(vpcItem);
    if (vpcAccountIds.includes(cdk.Stack.of(this).account) && vpcItem.region === cdk.Stack.of(this).region) {
      // Set VPC ID
      const vpcId = cdk.aws_ssm.StringParameter.valueForStringParameter(
        this,
        this.getSsmPath(SsmResourceType.VPC, [vpcItem.name]),
      );
      vpcMap.set(vpcItem.name, vpcId);
      // Set subnet IDs
      const ownedVpcIds = this.getVpcAccountIds(vpcItem);
      for (const subnetItem of vpcItem.subnets ?? []) {
        // Lookup all subnet ids if VPC is owned by this account
        // otherwise only lookup shared subnet ids
        if (
          ownedVpcIds.includes(cdk.Stack.of(this).account) ||
          (subnetItem.shareTargets &&
            this.getAccountIdsFromShareTarget(subnetItem.shareTargets).includes(cdk.Stack.of(this).account))
        ) {
          const subnetId = cdk.aws_ssm.StringParameter.valueForStringParameter(
            this,
            this.getSsmPath(SsmResourceType.SUBNET, [vpcItem.name, subnetItem.name]),
          );
          subnetMap.set(`${vpcItem.name}_${subnetItem.name}`, subnetId);
        }
      }
      // Set security group IDs
      for (const securityGroupItem of vpcItem.securityGroups ?? []) {
        const securityGroupId = cdk.aws_ssm.StringParameter.valueForStringParameter(
          this,
          this.getSsmPath(SsmResourceType.SECURITY_GROUP, [vpcItem.name, securityGroupItem.name]),
        );
        securityGroupMap.set(`${vpcItem.name}_${securityGroupItem.name}`, securityGroupId);
      }
    }
    return [vpcMap, subnetMap, securityGroupMap];
  }

  private createApplicationConfigResources(
    appConfigItem: AppConfigItem,
    maps: { securityGroupMap: Map<string, string>; subnetMap: Map<string, string>; vpcMap: Map<string, string> },
    configDirPath: string,
    allVpcItems: (VpcConfig | VpcTemplatesConfig)[],
    accessLogsBucket: string,
    cloudwatch: { key?: cdk.aws_kms.IKey; logRetentionInDays: number },
    lambdaKey?: cdk.aws_kms.IKey,
  ) {
    for (const vpcItem of allVpcItems) {
      if (vpcItem.name === appConfigItem.vpc) {
        // Get account IDs
        const vpcAccountIds = this.getVpcAccountIdsWithShared(vpcItem);
        if (vpcAccountIds.includes(cdk.Stack.of(this).account) && vpcItem.region === cdk.Stack.of(this).region) {
          // Create target group resource
          const targetGroups = this.createTargetGroup(
            appConfigItem.targetGroups ?? undefined,
            maps.vpcMap,
            appConfigItem.vpc,
            appConfigItem.name,
          )!;

          // Create network load balancer resource
          this.createNetworkLoadBalancer(
            appConfigItem.networkLoadBalancer ?? undefined,
            appConfigItem.name,
            appConfigItem.vpc,
            targetGroups,
            maps.subnetMap,
            accessLogsBucket,
          );

          // Create application load balancer resource
          this.createApplicationLoadBalancer(
            appConfigItem.applicationLoadBalancer ?? undefined,
            appConfigItem.vpc,
            appConfigItem.name,
            targetGroups,
            maps.securityGroupMap,
            maps.subnetMap,
            accessLogsBucket,
          );

          // create launch template resource
          const lt = this.createLaunchTemplate(
            appConfigItem.launchTemplate,
            appConfigItem.vpc,
            appConfigItem.name,
            maps.securityGroupMap,
            maps.subnetMap,
            configDirPath,
          );
          // create autoscaling group resource only if launch template and autoscaling are defined

          if (lt && appConfigItem.autoscaling) {
            this.createAutoScalingGroup(
              {
                autoscaling: appConfigItem.autoscaling,
                vpcName: appConfigItem.vpc,
                name: appConfigItem.name,
              },
              targetGroups,
              lt,
              maps.subnetMap,
              { key: cloudwatch.key, logRetentionInDays: cloudwatch.logRetentionInDays },
              lambdaKey,
            );
          }
        }
      }
    }
  }

  private createApplicationLoadBalancer(
    applicationLoadBalancer: ApplicationLoadBalancerConfig | undefined,
    vpcName: string,
    appName: string,
    targetGroups: TargetGroupItem[] | undefined,
    securityGroupMap: Map<string, string>,
    subnetMap: Map<string, string>,
    accessLogsBucket: string,
  ) {
    if (applicationLoadBalancer) {
      const subnets = this.getSubnets(applicationLoadBalancer.subnets ?? [], vpcName, subnetMap)!;
      const getSecurityGroups = this.getSecurityGroups(
        applicationLoadBalancer.securityGroups ?? [],
        vpcName,
        securityGroupMap,
      );
      // alb needs atleast 2 subnets
      if (subnets.length < 2) {
        throw new Error(
          `[customizations-application-stack] Found ${applicationLoadBalancer.subnets.length} ALB subnets: ${applicationLoadBalancer.subnets}. Minium 2 subnets in 2 AZs are required`,
        );
      }
      return new ApplicationLoadBalancer(this, `ApplicationLoadBalancer_${appName}`, {
        name: applicationLoadBalancer.name,
        ssmPrefix: this.props.prefixes.ssmParamName,
        subnets,
        securityGroups: getSecurityGroups!,
        scheme: applicationLoadBalancer.scheme! ?? 'internal',
        accessLogsBucket,
        attributes: applicationLoadBalancer.attributes ?? undefined,
        listeners: this.getAlbListenerTargetGroupArn(applicationLoadBalancer?.listeners ?? undefined, targetGroups),
      });
    } else {
      return undefined;
    }
  }
  private getAlbListenerTargetGroupArn(
    listeners: AlbListenerConfig[] | undefined,
    targetGroups: TargetGroupItem[] | undefined,
  ) {
    const output = [];
    // if listener is provided look up target group arn
    // if no target group is provided return undefined
    if (listeners && targetGroups) {
      for (const listener of listeners) {
        const targetGroupValues = targetGroups ?? [];

        const filteredTargetGroup = targetGroupValues.find(element => {
          return element.name === listener.targetGroup;
        });
        if (!filteredTargetGroup) {
          this.logger.error(`ALB Listener ${listener.name} does not have a valid target group ${listener.targetGroup}`);
          throw new Error(`Configuration validation failed at runtime.`);
        }
        listener.targetGroup = filteredTargetGroup.targetGroup.targetGroupArn;
        output.push(listener as ApplicationLoadBalancerListenerConfig);
      }
    } else {
      return undefined;
    }

    return output;
  }

  private createLaunchTemplate(
    launchTemplate: LaunchTemplateConfig | undefined,
    vpcName: string,
    appName: string,
    securityGroupMap: Map<string, string>,
    subnetMap: Map<string, string>,
    configDirPath: string,
  ) {
    if (launchTemplate) {
      const getSecurityGroups = this.getSecurityGroups(launchTemplate.securityGroups ?? [], vpcName, securityGroupMap);
      const blockDeviceMappingsValue = this.processBlockDeviceReplacements(
        launchTemplate.blockDeviceMappings ?? [],
        appName,
      );
      const networkInterfacesValue = this.replaceNetworkInterfaceValues(
        launchTemplate.networkInterfaces ?? [],
        vpcName,
        securityGroupMap,
        subnetMap,
      );
      const imageIdValue = this.replaceImageId(launchTemplate.imageId ?? '');
      return new LaunchTemplate(this, `LaunchTemplate-${pascalCase(appName)}-${pascalCase(launchTemplate.name)}`, {
        name: launchTemplate.name,
        appName: appName,
        vpc: vpcName,
        blockDeviceMappings: blockDeviceMappingsValue,
        userData:
          launchTemplate.userData &&
          // Applies replacements and return temp path if userData is defined in configuration
          this.generatePolicyReplacements(path.join(configDirPath, launchTemplate.userData), true),
        securityGroups: getSecurityGroups ?? undefined,
        networkInterfaces: networkInterfacesValue ?? undefined,
        instanceType: launchTemplate.instanceType,
        keyPair: launchTemplate.keyPair ?? undefined,
        iamInstanceProfile: launchTemplate.iamInstanceProfile ?? undefined,
        imageId: imageIdValue,
        enforceImdsv2: launchTemplate.enforceImdsv2 ?? true,
      });
    } else {
      return undefined;
    }
  }
  private replaceNetworkInterfaceValues(
    networkInterfaces: NetworkInterfaceItemConfig[],
    vpc: string,
    securityGroupMap: Map<string, string>,
    subnetMap: Map<string, string>,
  ) {
    for (const networkInterface of networkInterfaces) {
      const securityGroups: string[] | undefined = this.getSecurityGroups(
        networkInterface.groups! ?? [],
        vpc,
        securityGroupMap,
      );
      if (securityGroups) {
        networkInterface.groups = securityGroups;
      }
      if (networkInterface.subnetId) {
        const subnetIdValue = subnetMap.get(`${vpc}_${networkInterface.subnetId}`);
        if (!subnetIdValue) {
          this.logger.error(`Network Interfaces: subnet ${networkInterface.subnetId} not found in VPC ${vpc}`);
          throw new Error(`Configuration validation failed at runtime.`);
        }
        networkInterface.subnetId = subnetIdValue;
      }
    }

    return networkInterfaces;
  }

  private createAutoScalingGroup(
    appConfigItem: { autoscaling: AutoScalingConfig; vpcName: string; name: string },
    targetGroupsInput: TargetGroupItem[] | undefined,
    lt: LaunchTemplate,
    subnetMap: Map<string, string>,
    cloudwatch: { key?: cdk.aws_kms.IKey; logRetentionInDays: number },
    lambdaKey?: cdk.aws_kms.IKey,
  ) {
    let finalTargetGroupArns: string[] = [];
    // if input array is provided filter out targetGroup based on name
    if (targetGroupsInput) {
      const filteredTargetGroups = targetGroupsInput.filter(obj => {
        if (appConfigItem.autoscaling.targetGroups?.includes(obj.name)) {
          return obj;
        } else {
          return undefined;
        }
      });
      // get TargetGroup arn
      const filteredTargetGroupArns = filteredTargetGroups.map(obj => {
        return obj.targetGroup.targetGroupArn;
      });
      // merge targetGroup arns into array
      finalTargetGroupArns = [...filteredTargetGroupArns, ...finalTargetGroupArns];
    }

    // if array is empty returned undefined an input of [] is passed to api
    let finalTargetGroups: string[] | undefined;
    if (finalTargetGroupArns.length === 0) {
      finalTargetGroups = undefined;
    } else {
      finalTargetGroups = finalTargetGroupArns;
    }

    const subnets: string[] = [];
    for (const subnet of appConfigItem.autoscaling.subnets ?? []) {
      const subnetId = subnetMap.get(`${appConfigItem.vpcName}_${subnet}`);
      if (!subnetId) {
        throw new Error(
          `[customizations-application-stack] Create Autoscaling Groups: subnet ${subnet} not found in VPC ${appConfigItem.vpcName}`,
        );
      }
      subnets.push(subnetId);
    }
    const cloudWatchLogKmsKey = cloudwatch.key;
    const cloudWatchLogRetentionInDays = cloudwatch.logRetentionInDays;
    const asg = new AutoscalingGroup(
      this,
      `AutoScalingGroup${pascalCase(appConfigItem.name)}${pascalCase(appConfigItem.autoscaling.name)}`,
      {
        name: appConfigItem.autoscaling.name,
        minSize: appConfigItem.autoscaling.minSize,
        maxSize: appConfigItem.autoscaling.maxSize,
        desiredSize: appConfigItem.autoscaling.desiredSize,
        launchTemplateVersion: lt.version,
        launchTemplateId: lt.launchTemplateId,
        healthCheckGracePeriod: appConfigItem.autoscaling.healthCheckGracePeriod ?? undefined,
        healthCheckType: appConfigItem.autoscaling.healthCheckType ?? undefined,
        targetGroups: finalTargetGroups,
        subnets,
        lambdaKey,
        cloudWatchLogKmsKey,
        cloudWatchLogRetentionInDays,
        maxInstanceLifetime: appConfigItem.autoscaling.maxInstanceLifetime ?? undefined,
      },
    );

    this.nagSuppressionInputs.push({
      id: NagSuppressionRuleIds.AS3,
      details: [
        {
          path: `${this.stackName}/AutoScalingGroup${pascalCase(appConfigItem.name)}${pascalCase(
            appConfigItem.autoscaling.name,
          )}/Resource`,
          reason: 'Scaling policies are not offered as a part of this solution',
        },
      ],
    });
    this.nagSuppressionInputs.push({
      id: NagSuppressionRuleIds.IAM4,
      details: [
        {
          path: `${this.stackName}/AutoScalingGroup${pascalCase(appConfigItem.name)}${pascalCase(
            appConfigItem.autoscaling.name,
          )}/AutoScalingServiceLinkedRole/CreateServiceLinkedRoleFunction/ServiceRole/Resource`,
          reason: 'Custom resource Lambda role policy.',
        },
      ],
    });

    this.nagSuppressionInputs.push({
      id: NagSuppressionRuleIds.IAM5,
      details: [
        {
          path: `${this.stackName}/AutoScalingGroup${pascalCase(appConfigItem.name)}${pascalCase(
            appConfigItem.autoscaling.name,
          )}/AutoScalingServiceLinkedRole/CreateServiceLinkedRoleFunction/ServiceRole/DefaultPolicy/Resource`,
          reason: 'Custom resource Lambda role policy.',
        },
      ],
    });
    this.nagSuppressionInputs.push({
      id: NagSuppressionRuleIds.IAM4,
      details: [
        {
          path: `${this.stackName}/AutoScalingGroup${pascalCase(appConfigItem.name)}${pascalCase(
            appConfigItem.autoscaling.name,
          )}/AutoScalingServiceLinkedRole/CreateServiceLinkedRoleProvider/framework-onEvent/ServiceRole/Resource`,
          reason: 'Custom resource Lambda role policy.',
        },
      ],
    });

    this.nagSuppressionInputs.push({
      id: NagSuppressionRuleIds.IAM5,
      details: [
        {
          path: `${this.stackName}/AutoScalingGroup${pascalCase(appConfigItem.name)}${pascalCase(
            appConfigItem.autoscaling.name,
          )}/AutoScalingServiceLinkedRole/CreateServiceLinkedRoleProvider/framework-onEvent/ServiceRole/DefaultPolicy/Resource`,
          reason: 'Custom resource Lambda role policy.',
        },
      ],
    });

    return asg;
  }

  private createNetworkLoadBalancer(
    networkLoadBalancer: NetworkLoadBalancerConfig | undefined,
    appName: string,
    vpcName: string,
    targetGroups: TargetGroupItem[] | undefined,
    subnetMap: Map<string, string>,
    accessLogsBucket: string,
  ) {
    if (networkLoadBalancer) {
      const subnets = this.getSubnets(networkLoadBalancer.subnets ?? [], vpcName, subnetMap)!;
      // if empty array is passed for subnets throw error that there are no subnets
      // if subnets are not found which happens error is thrown in getSubnets function
      if (!subnets) {
        throw new Error(
          `[customizations-application-stack] NLB subnets: ${networkLoadBalancer.subnets} not found in vpc ${vpcName}`,
        );
      }
      const nlb = new NetworkLoadBalancer(this, pascalCase(`AppNlb${appName}${networkLoadBalancer.name}`), {
        name: networkLoadBalancer.name,
        ssmPrefix: this.props.prefixes.ssmParamName,
        appName: appName,
        vpcName: vpcName,
        subnets: subnets,
        scheme: networkLoadBalancer?.scheme ?? undefined,
        deletionProtection: networkLoadBalancer.deletionProtection ?? undefined,
        crossZoneLoadBalancing: networkLoadBalancer.crossZoneLoadBalancing ?? undefined,
        accessLogsBucket,
      });

      for (const listener of networkLoadBalancer.listeners ?? []) {
        const targetGroupValues = targetGroups! ?? [];
        const filteredTargetGroup = targetGroupValues.find(element => {
          return element.name === listener.targetGroup;
        });
        if (!filteredTargetGroup) {
          this.logger.error(`NLB Listener ${listener.name} does not have a valid target group ${listener.targetGroup}`);
          throw new Error(`Configuration validation failed at runtime.`);
        }
        const getCertificateValue = this.getCertificate(listener.certificate);
        new cdk.aws_elasticloadbalancingv2.CfnListener(this, pascalCase(`Listener${appName}${listener.name}`), {
          defaultActions: [
            {
              type: 'forward',
              forwardConfig: {
                targetGroups: [
                  {
                    targetGroupArn: filteredTargetGroup.targetGroup.targetGroupArn,
                  },
                ],
              },
              targetGroupArn: filteredTargetGroup.targetGroup.targetGroupArn,
            },
          ],
          loadBalancerArn: nlb.networkLoadBalancerArn,
          alpnPolicy: [listener.alpnPolicy!],
          certificates: [{ certificateArn: getCertificateValue }],
          port: listener.port!,
          protocol: listener.protocol!,
          sslPolicy: listener.sslPolicy!,
        });
      }
      return nlb;
    } else {
      return undefined;
    }
  }

  private getCertificate(certificate: string | undefined) {
    if (certificate) {
      //check if user provided arn. If so do nothing, if not get it from ssm
      if (certificate.match('\\arn:*')) {
        return certificate;
      } else {
        return cdk.aws_ssm.StringParameter.valueForStringParameter(
          this,
          this.getSsmPath(SsmResourceType.ACM_CERT, [certificate]),
        );
      }
    }
    return undefined;
  }
  private getSubnets(subnets: string[], vpc: string, subnetMap: Map<string, string>) {
    const output: string[] = [];
    for (const subnet of subnets ?? []) {
      const subnetId = subnetMap.get(`${vpc}_${subnet}`);
      if (!subnetId) {
        this.logger.error(`Subnet ${subnet} not found in VPC ${vpc}`);
        throw new Error(`Configuration validation failed at runtime.`);
      }
      output.push(subnetId);
    }
    if (output.length === 0) {
      return undefined;
    } else {
      return output;
    }
  }
  private getSecurityGroups(securityGroups: string[], vpc: string, securityGroupMap: Map<string, string>) {
    const output: string[] = [];
    for (const sg of securityGroups ?? []) {
      const sgId = securityGroupMap.get(`${vpc}_${sg}`);
      if (!sgId) {
        this.logger.error(`Security group ${sg} does not exist in VPC ${vpc}`);
        throw new Error(`Configuration validation failed at runtime.`);
      }
      output.push(sgId);
    }
    if (output.length === 0) {
      return undefined;
    } else {
      return output;
    }
  }

  private createTargetGroup(
    targetGroupsInput: TargetGroupItemConfig[] | undefined,
    vpcMap: Map<string, string>,
    vpcName: string,
    appName: string,
  ) {
    const output = [];
    const vpcId = vpcMap.get(vpcName);
    if (!vpcId) {
      this.logger.error(`Unable to locate VPC ${vpcName}`);
      throw new Error(`Configuration validation failed at runtime.`);
    }
    if (targetGroupsInput) {
      for (const targetGroup of targetGroupsInput) {
        const tg = new TargetGroup(this, pascalCase(`AppTargetGroup${appName}${targetGroup.name}`), {
          name: targetGroup.name,
          port: targetGroup.port,
          protocol: targetGroup.protocol,
          protocolVersion: targetGroup.protocolVersion! || undefined,
          type: targetGroup.type,
          attributes: targetGroup.attributes ?? undefined,
          healthCheck: targetGroup.healthCheck ?? undefined,
          threshold: targetGroup.threshold ?? undefined,
          matcher: targetGroup.matcher ?? undefined,
          vpc: vpcId,
        });
        const outputItem = { name: targetGroup.name, targetGroup: tg };
        output.push(outputItem);

        this.ssmParameters.push({
          logicalId: pascalCase(`SsmTg${appName}${vpcName}${targetGroup.name}Arn`),
          parameterName: this.getSsmPath(SsmResourceType.TARGET_GROUP, [appName, vpcName, targetGroup.name]),
          stringValue: tg.targetGroupArn,
        });
      }
    }
    if (output.length === 0) {
      return undefined;
    } else {
      return output;
    }
  }
}
