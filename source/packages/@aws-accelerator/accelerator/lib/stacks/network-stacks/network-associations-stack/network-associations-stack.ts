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
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { pascalCase } from 'change-case';
import { Construct } from 'constructs';

import {
  ApplicationLoadBalancerConfig,
  ApplicationLoadBalancerListenerConfig,
  AseaResourceType,
  CustomerGatewayConfig,
  DxGatewayConfig,
  DxTransitGatewayAssociationConfig,
  ManagedActiveDirectoryConfig,
  NetworkAclConfig,
  NetworkAclInboundRuleConfig,
  NetworkAclOutboundRuleConfig,
  NetworkAclSubnetSelection,
  NetworkLoadBalancerConfig,
  NlbTargetTypeConfig,
  RouteTableConfig,
  RouteTableEntryConfig,
  SubnetConfig,
  Tag,
  TargetGroupItemConfig,
  TransitGatewayAttachmentConfig,
  TransitGatewayConfig,
  TransitGatewayRouteEntryConfig,
  TransitGatewayRouteTableConfig,
  TransitGatewayRouteTableDxGatewayEntryConfig,
  TransitGatewayRouteTableTgwPeeringEntryConfig,
  TransitGatewayRouteTableVpcEntryConfig,
  TransitGatewayRouteTableVpnEntryConfig,
  VpcConfig,
  VpcPeeringConfig,
  VpcTemplatesConfig,
  VpnConnectionConfig,
  isNetworkType,
} from '@aws-accelerator/config';
import { ShareTargets } from '@aws-accelerator/config/dist/lib/common/types';
import {
  ActiveDirectory,
  ActiveDirectoryConfiguration,
  ActiveDirectoryResolverRule,
  AssociateHostedZones,
  CrossAccountRouteFramework,
  DirectConnectGatewayAssociation,
  DirectConnectGatewayAssociationProps,
  IpamSubnet,
  KeyLookup,
  NLBAddresses,
  PutSsmParameter,
  QueryLoggingConfigAssociation,
  ResolverFirewallRuleGroupAssociation,
  ResolverRuleAssociation,
  ShareActiveDirectory,
  ShareSubnetTags,
  SsmParameterLookup,
  SubnetIdLookup,
  TargetGroup,
  TransitGatewayAttachment,
  TransitGatewayAttachmentType,
  TransitGatewayConnect,
  TransitGatewayPrefixListReference,
  TransitGatewayRouteTableAssociation,
  TransitGatewayRouteTablePropagation,
  TransitGatewayStaticRoute,
  UserDataScriptsType,
  VpcIdLookup,
  VpcPeering,
  albListenerActionProperty,
} from '@aws-accelerator/constructs';
import { SsmResourceType } from '@aws-accelerator/utils/lib/ssm-parameter-path';

import path from 'path';
import { AcceleratorStackProps, NagSuppressionRuleIds } from '../../accelerator-stack';
import { NetworkStack } from '../network-stack';
import { getPrefixList } from '../utils/getter-utils';
import { isEc2FirewallVpnRoute, isIpv4 } from '../utils/validation-utils';
import { SharedResources } from './shared-resources';

interface Peering {
  name: string;
  requester: VpcConfig | VpcTemplatesConfig;
  accepter: VpcConfig | VpcTemplatesConfig;
  tags: cdk.CfnTag[] | undefined;
  crossAccount: boolean;
}

export class NetworkAssociationsStack extends NetworkStack {
  private dnsFirewallMap: Map<string, string>;
  private dxGatewayMap: Map<string, string>;
  private peeringList: Peering[];
  private prefixListMap: Map<string, string>;
  private queryLogMap: Map<string, string>;
  private resolverRuleMap: Map<string, string>;
  private routeTableMap: Map<string, string>;
  private transitGateways: Map<string, string>;
  private transitGatewayRouteTables: Map<string, string>;
  private transitGatewayAttachments: Map<string, string>;
  private crossAcctRouteProvider?: cdk.custom_resources.Provider;

  constructor(scope: Construct, id: string, props: AcceleratorStackProps) {
    super(scope, id, props);

    try {
      // Set private properties
      this.dnsFirewallMap = new Map<string, string>();
      this.dxGatewayMap = new Map<string, string>();
      this.queryLogMap = new Map<string, string>();
      this.resolverRuleMap = new Map<string, string>();
      this.transitGateways = new Map<string, string>();
      this.transitGatewayAttachments = new Map<string, string>();
      this.transitGatewayRouteTables = new Map<string, string>();

      //
      // Build VPC peering list
      //
      this.peeringList = this.setPeeringList();

      //
      // Create cross-account peering route provider, if required
      //
      this.crossAcctRouteProvider = this.createCrossAcctRouteProvider();

      //
      // Build prefix list map
      //
      this.prefixListMap = this.setPrefixListMap(props);

      //
      // Build route table map
      //
      this.routeTableMap = this.setRouteTableMap(this.vpcsInScope);
      // Get cross-account prefix list IDs as needed
      const crossAcctRouteTables = this.setCrossAcctRouteTables();
      crossAcctRouteTables.forEach((value, key) => this.routeTableMap.set(key, value));

      //
      // Create transit gateway route table associations, propagations,
      // for VPC and VPN attachments
      //
      this.createTransitGatewayResources(props);

      //
      // Create Route 53 private hosted zone associations
      //
      this.createHostedZoneAssociations();

      //
      // Create central network service VPC associations
      //
      this.createCentralNetworkAssociations(props);

      //
      // Create central network service VPC associations
      //
      this.createRoute53LocalVpcResources(props);

      //
      // Create VPC peering connections
      //
      this.createVpcPeeringConnections();

      //
      // Create Direct Connect resources
      //
      this.createDirectConnectResources(props);

      //
      // Create transit gateway static routes, blackhole
      // routes, and prefix list references
      //
      this.createTransitGatewayStaticRoutes(props);

      //
      // Create cross-account NACL Rules for IPAM Subnets
      //
      this.createCrossAccountNaclRules();

      //
      // Creates target groups for ALBs and NLBs
      //
      const targetGroupMap = this.createIpAndInstanceTargetGroups();

      //
      // Creates ALB Listeners
      //
      const albListenerMap = this.createAlbListeners(targetGroupMap);

      //
      // Create ALB target Groups after ALB listeners have been created
      //
      const albTargetGroupMap = this.createAlbTargetGroups(albListenerMap);

      //
      // Create NLB Listeners
      //
      const allTargetGroupsMap = new Map([...targetGroupMap, ...albTargetGroupMap]);
      this.createNlbListeners(allTargetGroupsMap);

      //
      // Apply tags to shared VPC/subnet resources
      //
      this.shareSubnetTags();

      //
      // Create resources for RAM shared subnets
      //
      const sharedVpcMap = this.setVpcMap(this.sharedVpcs);
      new SharedResources(this, sharedVpcMap, this.prefixListMap, targetGroupMap, props);

      //
      // Create SSM parameters
      //
      this.createSsmParameters();
      // Create managed active directories
      //
      this.createManagedActiveDirectories();

      //
      // Create Transit Gateway Connect resources for Vpc Attachments
      //
      this.createTransitGatewayConnect(props);

      //
      // Create NagSuppressions
      //
      this.addResourceSuppressionsByPath();

      this.logger.info('Completed stack synthesis');
    } catch (err) {
      this.logger.error(`${err}`);
      throw err;
    }
  }

  /**
   * Function to create listeners for given network load balancer
   * @param vpcItem {@link VpcConfig} | {@link VpcTemplatesConfig}
   * @param nlbItem {@link NetworkLoadBalancerConfig}
   * @param nlbId string
   * @param targetGroupMap Map<string, {@link TargetGroup}>
   *
   */
  private createNetworkLoadBalancerListeners(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    nlbItem: NetworkLoadBalancerConfig,
    nlbId: string,
    targetGroupMap: Map<string, TargetGroup>,
  ): void {
    for (const listener of nlbItem.listeners ?? []) {
      const targetGroup = targetGroupMap.get(`${vpcItem.name}-${listener.targetGroup}`);
      if (!targetGroup) {
        this.logger.error(
          `The Listener ${listener.name} contains an invalid target group name ${listener.targetGroup} please ensure that the the target group name references a valid target group`,
        );
        throw new Error(`Configuration validation failed at runtime.`);
      }
      new cdk.aws_elasticloadbalancingv2.CfnListener(
        this,
        pascalCase(`Listener${vpcItem.name}${nlbItem.name}${listener.name}`),
        {
          defaultActions: [
            {
              type: 'forward',
              forwardConfig: {
                targetGroups: [
                  {
                    targetGroupArn: targetGroup.targetGroupArn,
                  },
                ],
              },
              targetGroupArn: targetGroup.targetGroupArn,
            },
          ],
          loadBalancerArn: nlbId,
          alpnPolicy: [listener.alpnPolicy!],
          certificates: [{ certificateArn: this.getCertificate(listener.certificate) }],
          port: listener.port!,
          protocol: listener.protocol!,
          sslPolicy: listener.sslPolicy!,
        },
      );
    }
  }

  private createNlbListeners(targetGroupMap: Map<string, TargetGroup>) {
    for (const vpcItem of this.vpcResources) {
      const vpcAccountIds = this.getVpcAccountIds(vpcItem);
      if (this.isTargetStack(vpcAccountIds, [vpcItem.region])) {
        for (const nlbItem of vpcItem.loadBalancers?.networkLoadBalancers ?? []) {
          const nlbId = cdk.aws_ssm.StringParameter.valueForStringParameter(
            this,
            this.getSsmPath(SsmResourceType.NLB, [vpcItem.name, nlbItem.name]),
          );
          this.createNetworkLoadBalancerListeners(vpcItem, nlbItem, nlbId, targetGroupMap);
        }
      }
    }
  }

  /**
   * Function to create Application load balancer
   * @param vpcName string
   * @param vpcId string
   * @param targetGroupItem {@link TargetGroupItemConfig}
   * @param albNames string[]
   * @param loadBalancerListenerMap Map<string, {@link cdk.aws_elasticloadbalancingv2.CfnListener}>
   * @returns TargetGroup {@link TargetGroup}
   */
  private createApplicationLoadBalancerTargetGroup(
    vpcName: string,
    vpcId: string,
    targetGroupItem: TargetGroupItemConfig,
    albNames: string[],
    loadBalancerListenerMap: Map<string, cdk.aws_elasticloadbalancingv2.CfnListener>,
  ): TargetGroup {
    const updatedTargets = targetGroupItem.targets?.map(target => {
      if (albNames.includes(target as string)) {
        return cdk.aws_ssm.StringParameter.valueForStringParameter(
          this,
          this.getSsmPath(SsmResourceType.ALB, [vpcName, target as string]),
        );
      }
      return target;
    }) as string[];

    const targetGroup = new TargetGroup(this, pascalCase(`TargetGroup${targetGroupItem.name}`), {
      name: targetGroupItem.name,
      port: targetGroupItem.port,
      protocol: targetGroupItem.protocol,
      protocolVersion: targetGroupItem.protocolVersion! || undefined,
      type: targetGroupItem.type,
      attributes: targetGroupItem.attributes ?? undefined,
      healthCheck: targetGroupItem.healthCheck ?? undefined,
      threshold: targetGroupItem.threshold ?? undefined,
      matcher: targetGroupItem.matcher ?? undefined,
      targets: updatedTargets,
      vpc: vpcId,
    });
    for (const [key, value] of loadBalancerListenerMap.entries()) {
      if (key.startsWith(vpcName)) {
        targetGroup.node.addDependency(value);
      }
    }

    return targetGroup;
  }

  /**
   * Function to create application load balancer target groups
   * @param vpcItem {@link VpcConfig} | {@link VpcTemplatesConfig}
   * @param loadBalancerListenerMap Map<string, cdk.aws_elasticloadbalancingv2.CfnListener>
   * @param targetGroupMap Map<string, TargetGroup>
   */
  private createApplicationLoadBalancerTargetGroups(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    loadBalancerListenerMap: Map<string, cdk.aws_elasticloadbalancingv2.CfnListener>,
    targetGroupMap: Map<string, TargetGroup>,
  ): void {
    const vpcId = cdk.aws_ssm.StringParameter.valueForStringParameter(
      this,
      this.getSsmPath(SsmResourceType.VPC, [vpcItem.name]),
    );
    const albTargetGroups = vpcItem.targetGroups?.filter(targetGroup => targetGroup.type === 'alb') ?? [];
    const albNames = vpcItem.loadBalancers?.applicationLoadBalancers?.map(alb => alb.name) ?? [];

    for (const targetGroupItem of albTargetGroups) {
      if (this.isManagedByAsea(AseaResourceType.EC2_TARGET_GROUP, `${targetGroupItem.name}`)) {
        this.logger.info(`Application Load Balancer Target Group ${targetGroupItem.name} is managed externally.`);
        continue;
      }
      const targetGroup = this.createApplicationLoadBalancerTargetGroup(
        vpcItem.name,
        vpcId,
        targetGroupItem,
        albNames,
        loadBalancerListenerMap,
      );

      targetGroupMap.set(`${vpcItem.name}-${targetGroupItem.name}`, targetGroup);
    }
  }

  private createAlbTargetGroups(albListenerMap: Map<string, cdk.aws_elasticloadbalancingv2.CfnListener>) {
    const targetGroupMap = new Map<string, TargetGroup>();
    for (const vpcItem of this.vpcResources) {
      const vpcAccountIds = this.getVpcAccountIds(vpcItem);
      if (this.isTargetStack(vpcAccountIds, [vpcItem.region])) {
        this.createApplicationLoadBalancerTargetGroups(vpcItem, albListenerMap, targetGroupMap);
      }
    }
    return targetGroupMap;
  }

  /**
   * Function to create AApplication LoadBalancer listeners
   * @param vpcItem {@link VpcConfig } | {@link VpcTemplatesConfig}
   * @param albItem {@link ApplicationLoadBalancerConfig}
   * @param albArn string
   * @param targetGroupMap Map<string, TargetGroup>
   * @param listenerMap Map<string, {@link cdk.aws_elasticloadbalancingv2.CfnListener}>
   */
  private createApplicationLoadBalancerListeners(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    albItem: ApplicationLoadBalancerConfig,
    albArn: string,
    targetGroupMap: Map<string, TargetGroup>,
    listenerMap: Map<string, cdk.aws_elasticloadbalancingv2.CfnListener>,
  ): void {
    for (const listener of albItem.listeners ?? []) {
      if (this.isManagedByAsea(AseaResourceType.APPLICATION_LOAD_BALANCER, `${albItem.name}`)) {
        this.logger.info(`Application Load Balancer ${albItem.name} is managed externally.`);
        continue;
      }
      const targetGroup = targetGroupMap.get(`${vpcItem.name}-${listener.targetGroup}`);
      if (!targetGroup) {
        this.logger.error(
          `The Listener ${listener.name} contains an invalid target group name ${listener.targetGroup} please ensure that the the target group name references a valid target group`,
        );
        throw new Error(`Configuration validation failed at runtime.`);
      }
      const listenerAction: cdk.aws_elasticloadbalancingv2.CfnListener.ActionProperty = this.getListenerAction(
        listener,
        targetGroup.targetGroupArn,
      );

      const listenerResource = new cdk.aws_elasticloadbalancingv2.CfnListener(
        this,
        pascalCase(`Listener${vpcItem.name}${albItem.name}${listener.name}`),
        {
          defaultActions: [listenerAction],
          loadBalancerArn: albArn,
          certificates: [{ certificateArn: this.getCertificate(listener.certificate) }],
          port: listener.port,
          protocol: listener.protocol,
          sslPolicy: listener.sslPolicy!,
        },
      );
      listenerMap.set(`${vpcItem.name}-${albItem.name}-${listener.name}`, listenerResource);
    }
  }

  private createAlbListeners(targetGroupMap: Map<string, TargetGroup>) {
    try {
      const listenerMap = new Map<string, cdk.aws_elasticloadbalancingv2.CfnListener>();
      for (const vpcItem of this.props.networkConfig.vpcs ?? []) {
        for (const albItem of vpcItem.loadBalancers?.applicationLoadBalancers ?? []) {
          // Logic to determine that ALBs that are not shared are only created in the account of the VPC.
          const accountId = this.props.accountsConfig.getAccountId(vpcItem.account);
          if (!albItem.shareTargets && this.isTargetStack([accountId], [vpcItem.region])) {
            const albArn = cdk.aws_ssm.StringParameter.valueForStringParameter(
              this,
              this.getSsmPath(SsmResourceType.ALB, [vpcItem.name, albItem.name]),
            );
            this.createApplicationLoadBalancerListeners(vpcItem, albItem, albArn, targetGroupMap, listenerMap);
          }
        }
      }
      return listenerMap;
    } catch (err) {
      this.logger.error(err);
      throw err;
    }
  }
  public getCertificate(certificate: string | undefined) {
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

  public getListenerAction(
    listener: ApplicationLoadBalancerListenerConfig,
    targetGroupArn: string,
  ): cdk.aws_elasticloadbalancingv2.CfnListener.ActionProperty {
    const listenerTargetGroupArn = targetGroupArn;
    const actionValues: albListenerActionProperty = {
      type: listener.type,
      order: listener.order,
      targetGroupArn: listenerTargetGroupArn,
    };
    if (listener.type === 'forward') {
      actionValues.forwardConfig = {
        targetGroups: [{ targetGroupArn: targetGroupArn }],
        targetGroupStickinessConfig: listener.forwardConfig?.targetGroupStickinessConfig,
      };
    } else if (listener.type === 'redirect') {
      if (listener.redirectConfig) {
        actionValues.redirectConfig = {
          host: listener.redirectConfig.host,
          path: listener.redirectConfig.path,
          port: listener.redirectConfig.port?.toString() ?? undefined,
          protocol: listener.redirectConfig.protocol,
          query: listener.redirectConfig.query,
          statusCode: listener.redirectConfig.statusCode,
        };
      } else {
        this.logger.error(`Listener ${listener.name} is set to redirect but redirectConfig is not defined`);
        throw new Error(`Configuration validation failed at runtime.`);
      }
    } else if (listener.type === 'fixed-response') {
      if (listener.fixedResponseConfig) {
        actionValues.fixedResponseConfig = {
          contentType: listener.fixedResponseConfig.contentType,
          messageBody: listener.fixedResponseConfig.messageBody,
          statusCode: listener.fixedResponseConfig.statusCode,
        };
      } else {
        this.logger.error(`Listener ${listener.name} is set to fixed-response but fixedResponseConfig is not defined`);
        throw new Error(`Configuration validation failed at runtime.`);
      }
    } else {
      this.logger.error(`Listener ${listener.name} is not set to forward, fixed-response or redirect`);
      throw new Error(`Configuration validation failed at runtime.`);
    }

    return actionValues as cdk.aws_elasticloadbalancingv2.CfnListener.ActionProperty;
  }
  /**
   * Create Ip based target group
   */
  private createIpTargetGroup(
    targetGroupItem: TargetGroupItemConfig,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    vpcId: string,
  ) {
    // Create IP Target Group if no Targets are specified, otherwise, evaluate NLB/static IP targets
    if (!targetGroupItem.targets) {
      return new TargetGroup(this, `${vpcItem.name}-${targetGroupItem.name}`, {
        name: targetGroupItem.name,
        port: targetGroupItem.port,
        protocol: targetGroupItem.protocol,
        protocolVersion: targetGroupItem.protocolVersion,
        type: targetGroupItem.type,
        attributes: targetGroupItem.attributes,
        healthCheck: targetGroupItem.healthCheck,
        threshold: targetGroupItem.threshold,
        matcher: targetGroupItem.matcher,
        vpc: vpcId,
      });
    } else {
      try {
        //Get NLB Targets in Ip Targets for lookup
        const nlbTargets = targetGroupItem.targets?.filter(target => {
          return typeof target !== 'string';
        }) as NlbTargetTypeConfig[];

        //Set AccountIds for lookup Custom Resource
        const nlbTargetsWithAccountIds =
          (nlbTargets.map(nlbTarget => {
            const accountId = this.props.accountsConfig.getAccountId(nlbTarget.account);
            return {
              account: accountId,
              region: nlbTarget.region,
              nlbName: nlbTarget.nlbName,
            };
          }) as NlbTargetTypeConfig[]) ?? [];

        //Get targets containing an IP Address only
        const staticIpTargets: (NlbTargetTypeConfig | string)[] =
          (targetGroupItem.targets?.filter(target => typeof target === 'string') as string[]) ?? [];
        // If NLB targets exist, send both static ips and NLB targets to custom resource to create one entry for the target group
        if (nlbTargetsWithAccountIds && nlbTargetsWithAccountIds.length > 0) {
          const nlbAddresses = new NLBAddresses(this, `${targetGroupItem.name}-ipLookup`, {
            targets: [...nlbTargetsWithAccountIds, ...staticIpTargets],
            assumeRoleName: `${this.props.prefixes.accelerator}-GetNLBIPAddressLookup`,
            partition: cdk.Stack.of(this).partition,
            kmsKey: this.cloudwatchKey,
            logRetentionInDays: this.logRetention,
          });
          return new TargetGroup(this, `${vpcItem.name}-${targetGroupItem.name}`, {
            name: targetGroupItem.name,
            port: targetGroupItem.port,
            protocol: targetGroupItem.protocol,
            protocolVersion: targetGroupItem.protocolVersion,
            type: targetGroupItem.type,
            attributes: targetGroupItem.attributes,
            healthCheck: targetGroupItem.healthCheck,
            threshold: targetGroupItem.threshold,
            matcher: targetGroupItem.matcher,
            targets: nlbAddresses.ipAddresses,
            vpc: vpcId,
          });
        } else {
          // If only IP addresses exist, skip CR Lookup and make the target group directly
          return new TargetGroup(this, `${vpcItem.name}-${targetGroupItem.name}`, {
            name: targetGroupItem.name,
            port: targetGroupItem.port,
            protocol: targetGroupItem.protocol,
            protocolVersion: targetGroupItem.protocolVersion,
            type: targetGroupItem.type,
            attributes: targetGroupItem.attributes,
            healthCheck: targetGroupItem.healthCheck,
            threshold: targetGroupItem.threshold,
            matcher: targetGroupItem.matcher,
            targets: staticIpTargets as string[],
            vpc: vpcId,
          });
        }
      } catch (err) {
        this.logger.error(
          `Could not create target group for ${targetGroupItem.name} in vpc ${vpcItem.name}. Please review the target group configuration`,
        );
        throw new Error(`Configuration validation failed at runtime.`);
      }
    }
  }

  private createInstanceTargetGroups(
    targetGroupItem: TargetGroupItemConfig,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    vpcId: string,
  ) {
    return new TargetGroup(this, `${vpcItem.name}-${targetGroupItem.name}`, {
      name: targetGroupItem.name,
      port: targetGroupItem.port,
      protocol: targetGroupItem.protocol,
      protocolVersion: targetGroupItem.protocolVersion,
      type: targetGroupItem.type,
      attributes: targetGroupItem.attributes,
      healthCheck: targetGroupItem.healthCheck,
      threshold: targetGroupItem.threshold,
      matcher: targetGroupItem.matcher,
      targets: targetGroupItem.targets as string[],
      vpc: vpcId,
    });
  }

  /**
   * Function to create instance or IP target groups
   * @param vpcItem {@link VpcConfig} | {@link VpcTemplatesConfig}
   * @param vpcId string
   * @param targetGroupItem {@link TargetGroupItemConfig}
   * @param targetGroupMap Map<string, {@link TargetGroup}>
   */
  private createInstanceOrIpTargetGroups(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    vpcId: string,
    targetGroupItem: TargetGroupItemConfig,
    targetGroupMap: Map<string, TargetGroup>,
  ): void {
    if (targetGroupItem.type === 'ip') {
      const targetGroup = this.createIpTargetGroup(targetGroupItem, vpcItem, vpcId);
      targetGroupMap.set(`${vpcItem.name}-${targetGroupItem.name}`, targetGroup);
    }
    if (targetGroupItem.type === 'instance') {
      const targetGroup = this.createInstanceTargetGroups(targetGroupItem, vpcItem, vpcId);
      targetGroupMap.set(`${vpcItem.name}-${targetGroupItem.name}`, targetGroup);
    }
  }

  private createIpAndInstanceTargetGroups() {
    try {
      const targetGroupMap = new Map<string, TargetGroup>();
      for (const vpcItem of this.props.networkConfig.vpcs) {
        for (const targetGroupItem of vpcItem.targetGroups ?? []) {
          if (targetGroupItem.shareTargets) {
            const sharedTargetGroup = this.checkResourceShare(targetGroupItem.shareTargets);
            if (sharedTargetGroup && vpcItem.region === cdk.Stack.of(this).region) {
              const vpcId = cdk.aws_ssm.StringParameter.valueForStringParameter(
                this,
                this.getSsmPath(SsmResourceType.VPC, [vpcItem.name]),
              );
              this.createInstanceOrIpTargetGroups(vpcItem, vpcId, targetGroupItem, targetGroupMap);
            }
          }
          const vpcAccountId = this.props.accountsConfig.getAccountId(vpcItem.account);
          if (!targetGroupItem.shareTargets && this.isTargetStack([vpcAccountId], [vpcItem.region])) {
            const vpcId = cdk.aws_ssm.StringParameter.valueForStringParameter(
              this,
              this.getSsmPath(SsmResourceType.VPC, [vpcItem.name]),
            );
            this.createInstanceOrIpTargetGroups(vpcItem, vpcId, targetGroupItem, targetGroupMap);
          }
        }
      }

      return targetGroupMap;
    } catch (err) {
      this.logger.error(err);
      throw err;
    }
  }
  /**
   * Create an array of peering connections
   */
  private setPeeringList() {
    const peeringList: Peering[] = [];
    /**
     * Verifies if given peering configuration is cross account or not.
     * @param peering
     * @returns
     * False: If one of the peering vpcs is from a vpcTemplate and there is only one and same account matching vpcs.
     * True: If one of the peering vpcs is from a vpcTemplate and length of vpc deployment target is not same or there is additional account in deployment target apart from accepter.
     * True: If region of VPCs is different.
     * True: If both vpcs are from vpcs configuration with different account.
     */
    const isCrossAccountPeering = (peering: VpcPeeringConfig) => {
      const requesterVpc = this.vpcResources.find(item => item.name === peering.vpcs[0])!;
      const accepterVpc = this.vpcResources.find(item => item.name === peering.vpcs[1])!;
      const requesterAccountIds = this.getVpcAccountIds(requesterVpc);
      const accepterAccountIds = this.getVpcAccountIds(accepterVpc);
      let crossAccount = false;
      if (
        isNetworkType<VpcTemplatesConfig>('IVpcTemplatesConfig', requesterVpc) ||
        isNetworkType<VpcTemplatesConfig>('IVpcTemplatesConfig', accepterVpc)
      ) {
        crossAccount =
          requesterVpc.region !== accepterVpc.region ||
          requesterAccountIds.length !== accepterAccountIds.length ||
          requesterAccountIds.filter(requesterAccountId => !accepterAccountIds.includes(requesterAccountId)).length > 0;
      } else {
        crossAccount = requesterVpc.account !== accepterVpc.account || requesterVpc.region !== accepterVpc.region;
      }
      return crossAccount;
    };

    for (const peering of this.props.networkConfig.vpcPeering ?? []) {
      // Get requester and accepter VPC configurations
      const requesterVpc = this.vpcResources.find(item => item.name === peering.vpcs[0])!;
      const accepterVpc = this.vpcResources.find(item => item.name === peering.vpcs[1])!;
      const requesterAccountIds = this.getVpcAccountIds(requesterVpc);
      // Check if requester VPC is in this account and region
      if (this.isTargetStack(requesterAccountIds, [requesterVpc.region])) {
        peeringList.push({
          name: peering.name,
          requester: requesterVpc,
          accepter: accepterVpc,
          tags: peering.tags,
          crossAccount: isCrossAccountPeering(peering),
        });
      }
    }
    return peeringList;
  }

  /**
   * Function to check route table entry if Cross Account Route Framework or not
   * @returns boolean
   */
  private isCrossAccountRouteFramework(): boolean {
    let crossAccountRouteFramework = false;
    for (const peering of this.peeringList) {
      for (const routeTable of peering.accepter.routeTables ?? []) {
        for (const routeTableEntry of routeTable.routes ?? []) {
          if (
            routeTableEntry.type &&
            routeTableEntry.type === 'vpcPeering' &&
            routeTableEntry.target === peering.name
          ) {
            crossAccountRouteFramework = peering.crossAccount;
          }
        }
      }
    }

    return crossAccountRouteFramework;
  }

  /**
   * Create a custom resource provider to handle cross-account VPC peering routes
   * @returns
   */
  private createCrossAcctRouteProvider(): cdk.custom_resources.Provider | undefined {
    if (this.isCrossAccountRouteFramework()) {
      const provider = new CrossAccountRouteFramework(this, 'CrossAccountRouteFramework', {
        acceleratorPrefix: this.props.prefixes.accelerator,
        logGroupKmsKey: this.cloudwatchKey,
        logRetentionInDays: this.logRetention,
      }).provider;

      this.nagSuppressionInputs.push({
        id: NagSuppressionRuleIds.IAM4,
        details: [
          {
            path: `${this.stackName}/CrossAccountRouteFramework/CrossAccountRouteFunction/ServiceRole/Resource`,
            reason: 'Custom resource provider requires managed policy',
          },
          {
            path: `${this.stackName}/CrossAccountRouteFramework/CrossAccountRouteProvider/framework-onEvent/ServiceRole/Resource`,
            reason: 'Custom resource provider requires managed policy',
          },
        ],
      });

      this.nagSuppressionInputs.push({
        id: NagSuppressionRuleIds.IAM5,
        details: [
          {
            path: `${this.stackName}/CrossAccountRouteFramework/CrossAccountRouteFunction/ServiceRole/DefaultPolicy/Resource`,
            reason: 'Custom resource provider requires access to assume cross-account role',
          },
          {
            path: `${this.stackName}/CrossAccountRouteFramework/CrossAccountRouteProvider/framework-onEvent/ServiceRole/DefaultPolicy/Resource`,
            reason: 'Custom resource provider requires access to assume cross-account role',
          },
        ],
      });

      return provider;
    }
    return undefined;
  }

  /**
   * Create a map of prefix list IDs
   * @param props
   */
  private setPrefixListMap(props: AcceleratorStackProps): Map<string, string> {
    const prefixListMap = new Map<string, string>();
    for (const prefixListItem of props.networkConfig.prefixLists ?? []) {
      const prefixListTargets = this.getPrefixListTargets(prefixListItem);

      if (this.isTargetStack(prefixListTargets.accountIds, prefixListTargets.regions)) {
        const prefixListId = cdk.aws_ssm.StringParameter.valueForStringParameter(
          this,
          this.getSsmPath(SsmResourceType.PREFIX_LIST, [prefixListItem.name]),
        );
        prefixListMap.set(prefixListItem.name, prefixListId);
      }
    }

    // Get cross-account prefix list IDs as needed
    const crossAcctPrefixLists = this.setCrossAcctPrefixLists();
    crossAcctPrefixLists.forEach((value, key) => prefixListMap.set(key, value));
    return prefixListMap;
  }

  /**
   * Get cross-account prefix list IDs
   */
  private setCrossAcctPrefixLists(): Map<string, string> {
    const prefixListMap = new Map<string, string>();
    for (const peering of this.peeringList) {
      // Get account IDs
      const accepterAccountIds = this.getVpcAccountIds(peering.accepter);
      accepterAccountIds.forEach(accepterAccountId => {
        for (const routeTable of peering.accepter.routeTables ?? []) {
          for (const routeTableEntry of routeTable.routes ?? []) {
            const mapKey = `${accepterAccountId}_${peering.accepter.region}_${routeTableEntry.destinationPrefixList}`;
            if (
              routeTableEntry.type &&
              routeTableEntry.type === 'vpcPeering' &&
              routeTableEntry.target === peering.name &&
              peering.crossAccount &&
              routeTableEntry.destinationPrefixList &&
              !prefixListMap.has(mapKey)
            ) {
              const prefixListId = new SsmParameterLookup(
                this,
                pascalCase(`SsmParamLookup${routeTableEntry.destinationPrefixList}`),
                {
                  name: this.getSsmPath(SsmResourceType.PREFIX_LIST, [routeTableEntry.destinationPrefixList]),
                  accountId: accepterAccountId,
                  parameterRegion: peering.accepter.region,
                  roleName: `${this.props.prefixes.accelerator}-VpcPeeringRole-${peering.accepter.region}`,
                  kmsKey: this.cloudwatchKey,
                  logRetentionInDays: this.logRetention,
                  acceleratorPrefix: this.props.prefixes.accelerator,
                },
              ).value;
              prefixListMap.set(mapKey, prefixListId);
            }
          }
        }
      });
    }
    return prefixListMap;
  }

  /**
   * Get cross-account route tables
   */
  private setCrossAcctRouteTables(): Map<string, string> {
    const routeTableMap = new Map<string, string>();
    for (const peering of this.peeringList) {
      // Get account IDs
      const accepterAccountIds = this.getVpcAccountIds(peering.accepter);
      accepterAccountIds.forEach(accepterAccountId => {
        for (const routeTable of peering.accepter.routeTables ?? []) {
          for (const routeTableEntry of routeTable.routes ?? []) {
            if (
              routeTableEntry.type &&
              routeTableEntry.type === 'vpcPeering' &&
              routeTableEntry.target === peering.name &&
              peering.crossAccount &&
              this.account !== accepterAccountId &&
              !routeTableMap.has(`${peering.accepter.name}_${accepterAccountId}_${routeTable.name}`)
            ) {
              const routeTableId = new SsmParameterLookup(
                this,
                pascalCase(`SsmParamLookup${peering.accepter.name}${accepterAccountId}${routeTable.name}`),
                {
                  name: this.getSsmPath(SsmResourceType.ROUTE_TABLE, [peering.accepter.name, routeTable.name]),
                  accountId: accepterAccountId,
                  parameterRegion: peering.accepter.region,
                  roleName: `${this.props.prefixes.accelerator}-VpcPeeringRole-${peering.accepter.region}`,
                  kmsKey: this.cloudwatchKey,
                  logRetentionInDays: this.logRetention,
                  acceleratorPrefix: this.props.prefixes.accelerator,
                },
              ).value;
              routeTableMap.set(`${peering.accepter.name}_${accepterAccountId}_${routeTable.name}`, routeTableId);
            }
          }
        }
      });
    }
    return routeTableMap;
  }

  /**
   * Create transit gateway resources
   * @param props
   */
  private createTransitGatewayResources(props: AcceleratorStackProps) {
    //
    // Build Transit Gateway Maps
    //
    for (const tgwItem of props.networkConfig.transitGateways ?? []) {
      this.setTransitGatewayMap(tgwItem);
      this.setTransitGatewayRouteTableMap(tgwItem);
    }

    //
    // Create Transit Gateway route table associations and propagations
    // for VPC attachments
    //
    for (const vpcItem of this.vpcResources) {
      this.setTransitGatewayVpcAttachmentsMap(vpcItem);
      this.createVpcTransitGatewayAssociations(vpcItem);
      this.createVpcTransitGatewayPropagations(vpcItem);
    }

    //
    // Create Transit Gateway route table associations and propagations
    // for VPN attachments
    //
    for (const cgwItem of props.networkConfig.customerGateways ?? []) {
      if (isIpv4(cgwItem.ipAddress)) {
        for (const vpnItem of cgwItem.vpnConnections ?? []) {
          this.setTransitGatewayVpnAttachmentsMap(props, cgwItem, vpnItem);
          this.createVpnTransitGatewayAssociations(cgwItem, vpnItem);
          this.createVpnTransitGatewayPropagations(cgwItem, vpnItem);
        }
      }
    }
  }

  /**
   * Set transit gateways map
   * @param tgwItem
   */
  private setTransitGatewayMap(tgwItem: TransitGatewayConfig): void {
    const accountId = this.props.accountsConfig.getAccountId(tgwItem.account);
    if (this.isTargetStack([accountId], [tgwItem.region])) {
      const transitGatewayId = ssm.StringParameter.valueForStringParameter(
        this,
        this.getSsmPath(SsmResourceType.TGW, [tgwItem.name]),
      );
      this.transitGateways.set(tgwItem.name, transitGatewayId);
    }
  }

  /**
   * Set transit gateway route table map
   * @param tgwItem
   */
  private setTransitGatewayRouteTableMap(tgwItem: TransitGatewayConfig): void {
    const accountId = this.props.accountsConfig.getAccountId(tgwItem.account);
    if (this.isTargetStack([accountId], [tgwItem.region])) {
      for (const routeTableItem of tgwItem.routeTables ?? []) {
        const transitGatewayRouteTableId = ssm.StringParameter.valueForStringParameter(
          this,
          this.getSsmPath(SsmResourceType.TGW_ROUTE_TABLE, [tgwItem.name, routeTableItem.name]),
        );
        const key = `${tgwItem.name}_${routeTableItem.name}`;
        this.transitGatewayRouteTables.set(key, transitGatewayRouteTableId);
      }
    }
  }

  /**
   * Get account names and excluded account IDs for transit gateway attachments
   * @param vpcItem
   * @returns
   */
  private getTransitGatewayAttachmentAccounts(vpcItem: VpcConfig | VpcTemplatesConfig): [string[], string[]] {
    let accountNames: string[];
    let excludedAccountIds: string[] = [];
    if (isNetworkType<VpcConfig>('IVpcConfig', vpcItem)) {
      accountNames = [vpcItem.account];
    } else {
      accountNames = this.getAccountNamesFromDeploymentTarget(vpcItem.deploymentTargets);
      excludedAccountIds = this.getExcludedAccountIds(vpcItem.deploymentTargets);
    }
    return [accountNames, excludedAccountIds];
  }

  /**
   * Function to create TGW attachments map
   * @param vpcItem {@link VpcConfig} | {@link VpcTemplatesConfig}
   * @param tgwAttachmentItem {@link TransitGatewayAttachmentConfig}
   * @param accountNames string[]
   * @param excludedAccountIds string[]
   * @param accountId string
   * @param transitGatewayId string
   */
  private createTransitGatewayAttachmentsMap(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    tgwAttachmentItem: TransitGatewayAttachmentConfig,
    accountNames: string[],
    excludedAccountIds: string[],
    accountId: string,
    transitGatewayId: string,
  ): void {
    for (const owningAccount of accountNames) {
      let transitGatewayAttachmentId;
      const owningAccountId = this.props.accountsConfig.getAccountId(owningAccount);
      const attachmentKey = `${tgwAttachmentItem.transitGateway.name}_${owningAccount}_${vpcItem.name}`;
      // Skip iteration if account is excluded
      if (excludedAccountIds.includes(owningAccountId)) {
        continue;
      }

      if (accountId === owningAccountId) {
        this.logger.info(
          `Update route tables for attachment ${tgwAttachmentItem.name} from local account ${owningAccountId}`,
        );
        transitGatewayAttachmentId = ssm.StringParameter.valueForStringParameter(
          this,
          this.getSsmPath(SsmResourceType.TGW_ATTACHMENT, [vpcItem.name, tgwAttachmentItem.name]),
        );
        this.transitGatewayAttachments.set(attachmentKey, transitGatewayAttachmentId);
      } else {
        this.logger.info(
          `Update route tables for attachment ${tgwAttachmentItem.name} from external account ${owningAccountId}`,
        );

        const transitGatewayAttachment = TransitGatewayAttachment.fromLookup(
          this,
          pascalCase(`${tgwAttachmentItem.name}${owningAccount}VpcTransitGatewayAttachment`),
          {
            name: tgwAttachmentItem.name,
            owningAccountId,
            transitGatewayId,
            type: TransitGatewayAttachmentType.VPC,
            roleName: `${this.props.prefixes.accelerator}-DescribeTgwAttachRole-${cdk.Stack.of(this).region}`,
            kmsKey: this.cloudwatchKey,
            logRetentionInDays: this.logRetention,
          },
        );
        // Build Transit Gateway Attachment Map
        transitGatewayAttachmentId = transitGatewayAttachment.transitGatewayAttachmentId;
        this.transitGatewayAttachments.set(attachmentKey, transitGatewayAttachmentId);
      }
    }
  }

  /**
   * Create a map of transit gateway attachments
   * @param vpcItem
   */
  private setTransitGatewayVpcAttachmentsMap(vpcItem: VpcConfig | VpcTemplatesConfig) {
    // Get account names for attachment keys
    const [accountNames, excludedAccountIds] = this.getTransitGatewayAttachmentAccounts(vpcItem);

    if (vpcItem.region === cdk.Stack.of(this).region) {
      for (const tgwAttachmentItem of vpcItem.transitGatewayAttachments ?? []) {
        const accountId = this.props.accountsConfig.getAccountId(tgwAttachmentItem.transitGateway.account);

        if (accountId === cdk.Stack.of(this).account) {
          // Get the Transit Gateway ID
          const transitGatewayId = this.transitGateways.get(tgwAttachmentItem.transitGateway.name);
          if (!transitGatewayId) {
            this.logger.error(`Transit Gateway ${tgwAttachmentItem.transitGateway.name} not found`);
            throw new Error(`Configuration validation failed at runtime.`);
          }

          // Get the Transit Gateway Attachment ID
          this.createTransitGatewayAttachmentsMap(
            vpcItem,
            tgwAttachmentItem,
            accountNames,
            excludedAccountIds,
            accountId,
            transitGatewayId,
          );
        }
      }
    }
  }

  /**
   * Function to create TGW route table association
   * @param vpcItem {@link VpcConfig} | {@link VpcTemplatesConfig}
   * @param tgwAttachmentItem {@link TransitGatewayAttachmentConfig}
   * @param owningAccount string
   * @param attachmentKey string
   */
  private createTransitGatewayRouteTableAssociation(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    tgwAttachmentItem: TransitGatewayAttachmentConfig,
    owningAccount: string,
    attachmentKey: string,
  ): void {
    // Get transit gateway attachment ID
    const transitGatewayAttachmentId = this.transitGatewayAttachments.get(attachmentKey);
    if (!transitGatewayAttachmentId) {
      this.logger.error(`Transit Gateway attachment ${attachmentKey} not found`);
      throw new Error(`Configuration validation failed at runtime.`);
    }
    for (const routeTableItem of tgwAttachmentItem.routeTableAssociations ?? []) {
      if (
        this.isManagedByAsea(
          AseaResourceType.TRANSIT_GATEWAY_ASSOCIATION,
          `${owningAccount}/${tgwAttachmentItem.transitGateway.name}/${tgwAttachmentItem.name}/${routeTableItem}`,
        )
      )
        continue;
      const associationsKey = `${tgwAttachmentItem.transitGateway.name}_${routeTableItem}`;
      let associationId: string;
      if (isNetworkType<VpcConfig>('IVpcConfig', vpcItem)) {
        associationId = `${pascalCase(tgwAttachmentItem.name)}${pascalCase(routeTableItem)}Association`;
      } else {
        associationId = `${pascalCase(tgwAttachmentItem.name)}${pascalCase(routeTableItem)}${pascalCase(
          owningAccount,
        )}Association`;
      }

      const transitGatewayRouteTableId = this.transitGatewayRouteTables.get(associationsKey);
      if (transitGatewayRouteTableId === undefined) {
        this.logger.error(`Transit Gateway Route Table ${associationsKey} not found`);
        throw new Error(`Configuration validation failed at runtime.`);
      }

      new TransitGatewayRouteTableAssociation(this, associationId, {
        transitGatewayAttachmentId,
        transitGatewayRouteTableId,
      });
    }
  }

  /**
   * Function to process Transit Gateway attachment account list and create Transit Gateway Route Table Associations
   * @param vpcItem {@link VpcConfig} | {@link VpcTemplatesConfig}
   * @param tgwAttachmentItem {@link TransitGatewayAttachmentConfig}
   * @param accountNames string[]
   * @param excludedAccountIds string[]
   */
  private processTransitGatewayAttachmentAccountsToCreateTgwRtAssociations(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    tgwAttachmentItem: TransitGatewayAttachmentConfig,
    accountNames: string[],
    excludedAccountIds: string[],
  ) {
    // Get the Transit Gateway Attachment ID
    for (const owningAccount of accountNames) {
      const owningAccountId = this.props.accountsConfig.getAccountId(owningAccount);
      const attachmentKey = `${tgwAttachmentItem.transitGateway.name}_${owningAccount}_${vpcItem.name}`;
      // Skip iteration if account is excluded
      if (excludedAccountIds.includes(owningAccountId)) {
        continue;
      }
      // Create TGW route table association
      this.createTransitGatewayRouteTableAssociation(vpcItem, tgwAttachmentItem, owningAccount, attachmentKey);
    }
  }

  /**
   * Create transit gateway route table associations for VPC attachments
   * @param vpcItem
   */
  private createVpcTransitGatewayAssociations(vpcItem: VpcConfig | VpcTemplatesConfig): void {
    // Get account names for attachment keys
    const [accountNames, excludedAccountIds] = this.getTransitGatewayAttachmentAccounts(vpcItem);

    if (vpcItem.region === cdk.Stack.of(this).region) {
      for (const tgwAttachmentItem of vpcItem.transitGatewayAttachments ?? []) {
        const accountId = this.props.accountsConfig.getAccountId(tgwAttachmentItem.transitGateway.account);
        if (accountId === cdk.Stack.of(this).account) {
          // Get the Transit Gateway Attachment ID
          this.processTransitGatewayAttachmentAccountsToCreateTgwRtAssociations(
            vpcItem,
            tgwAttachmentItem,
            accountNames,
            excludedAccountIds,
          );
        }
      }
    }
  }

  /**
   * Function to create TGW route table propagation
   * @param vpcItem {@link VpcConfig} | {@link VpcTemplatesConfig}
   * @param tgwAttachmentItem {@link TransitGatewayAttachmentConfig}
   * @param owningAccount string
   * @param attachmentKey string
   */
  private createTransitGatewayRouteTablePropagation(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    tgwAttachmentItem: TransitGatewayAttachmentConfig,
    owningAccount: string,
    attachmentKey: string,
  ): void {
    // Get transit gateway attachment ID
    const transitGatewayAttachmentId = this.transitGatewayAttachments.get(attachmentKey);
    if (!transitGatewayAttachmentId) {
      this.logger.error(`Transit Gateway attachment ${attachmentKey} not found`);
      throw new Error(`Configuration validation failed at runtime.`);
    }
    for (const routeTableItem of tgwAttachmentItem.routeTablePropagations ?? []) {
      if (
        this.isManagedByAsea(
          AseaResourceType.TRANSIT_GATEWAY_PROPAGATION,
          `${owningAccount}/${tgwAttachmentItem.transitGateway.name}/${tgwAttachmentItem.name}/${routeTableItem}`,
        )
      )
        continue;
      const propagationsKey = `${tgwAttachmentItem.transitGateway.name}_${routeTableItem}`;
      let propagationId: string;
      if (isNetworkType('IVpcConfig', vpcItem)) {
        propagationId = `${pascalCase(tgwAttachmentItem.name)}${pascalCase(routeTableItem)}Propagation`;
      } else {
        propagationId = `${pascalCase(tgwAttachmentItem.name)}${pascalCase(routeTableItem)}${pascalCase(
          owningAccount,
        )}Propagation`;
      }

      const transitGatewayRouteTableId = this.transitGatewayRouteTables.get(propagationsKey);
      if (!transitGatewayRouteTableId) {
        this.logger.error(`Transit Gateway Route Table ${propagationsKey} not found`);
        throw new Error(`Configuration validation failed at runtime.`);
      }

      new TransitGatewayRouteTablePropagation(this, propagationId, {
        transitGatewayAttachmentId,
        transitGatewayRouteTableId,
      });
    }
  }

  /**
   * Function to process Transit Gateway attachment account list and create Transit Gateway Route Table Propagations
   * @param vpcItem {@link VpcConfig} | {@link VpcTemplatesConfig}
   * @param tgwAttachmentItem {@link TransitGatewayAttachmentConfig}
   * @param accountNames string[]
   * @param excludedAccountIds string[]
   */
  private processTransitGatewayAttachmentAccountsToCreateTgwRtPropagations(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    tgwAttachmentItem: TransitGatewayAttachmentConfig,
    accountNames: string[],
    excludedAccountIds: string[],
  ) {
    // Loop through attachment owner accounts
    for (const owningAccount of accountNames) {
      const owningAccountId = this.props.accountsConfig.getAccountId(owningAccount);
      const attachmentKey = `${tgwAttachmentItem.transitGateway.name}_${owningAccount}_${vpcItem.name}`;
      // Skip iteration if account is excluded
      if (excludedAccountIds.includes(owningAccountId)) {
        continue;
      }

      // Create TGW route table propagation
      this.createTransitGatewayRouteTablePropagation(vpcItem, tgwAttachmentItem, owningAccount, attachmentKey);
    }
  }
  /**
   * Create transit gateway route table propagations for VPC attachments
   * @param vpcItem
   */
  private createVpcTransitGatewayPropagations(vpcItem: VpcConfig | VpcTemplatesConfig): void {
    // Get account names for attachment keys
    const [accountNames, excludedAccountIds] = this.getTransitGatewayAttachmentAccounts(vpcItem);

    if (vpcItem.region === cdk.Stack.of(this).region) {
      for (const tgwAttachmentItem of vpcItem.transitGatewayAttachments ?? []) {
        const accountId = this.props.accountsConfig.getAccountId(tgwAttachmentItem.transitGateway.account);
        if (accountId === cdk.Stack.of(this).account) {
          this.processTransitGatewayAttachmentAccountsToCreateTgwRtPropagations(
            vpcItem,
            tgwAttachmentItem,
            accountNames,
            excludedAccountIds,
          );
        }
      }
    }
  }

  /**
   * Create transit gateway connection resources
   * @param props
   */
  private createTransitGatewayConnect(props: AcceleratorStackProps): void {
    for (const connectItem of props.networkConfig.transitGatewayConnects ?? []) {
      const accountId = this.props.accountsConfig.getAccountId(connectItem.transitGateway.account);
      if (accountId === cdk.Stack.of(this).account && connectItem.region === cdk.Stack.of(this).region) {
        const isVpcAttachment = connectItem.vpc;
        const vpcAttachmentItem = props.networkConfig.vpcs.find(item => item.name === connectItem.vpc?.vpcName);
        const attachmentKey = isVpcAttachment
          ? `${connectItem.transitGateway.name}_${vpcAttachmentItem?.account}_${connectItem.vpc.vpcName}`
          : `${connectItem.directConnect}_${connectItem.transitGateway.name}`;

        const transitGatewayAttachmentId = this.transitGatewayAttachments.get(attachmentKey);

        if (!transitGatewayAttachmentId) {
          this.logger.error(`Transit Gateway attachment ${attachmentKey} not found`);
          throw new Error(`Configuration validation failed at runtime.`);
        }

        this.logger.info(`Creating a TGW Connect for: ${connectItem.name}`);
        new TransitGatewayConnect(this, pascalCase(`${connectItem.name}TransitGatewayConnectAttachment`), {
          name: connectItem.name,
          transitGatewayAttachmentId: transitGatewayAttachmentId,
          options: connectItem.options!,
          tags: connectItem.tags,
        });
      }
    }
  }

  /**
   * Set VPN attachment items in TGW map
   * @param props
   * @param cgwItem
   * @param vpnItem
   */
  private setTransitGatewayVpnAttachmentsMap(
    props: AcceleratorStackProps,
    cgwItem: CustomerGatewayConfig,
    vpnItem: VpnConnectionConfig,
  ): void {
    const accountId = props.accountsConfig.getAccountId(cgwItem.account);
    if (
      accountId === cdk.Stack.of(this).account &&
      cgwItem.region === cdk.Stack.of(this).region &&
      vpnItem.transitGateway
    ) {
      // Lookup TGW attachment ID for VPN
      const tgw = props.networkConfig.transitGateways.find(tgwItem => tgwItem.name === vpnItem.transitGateway)!;
      const transitGatewayId = this.transitGateways.get(tgw.name);

      if (!transitGatewayId) {
        this.logger.error(`Transit Gateway ${tgw.name} not found`);
        throw new Error(`Configuration validation failed at runtime.`);
      }

      const vpnAttachmentId = TransitGatewayAttachment.fromLookup(
        this,
        pascalCase(`${vpnItem.name}VpnTransitGatewayAttachment`),
        {
          name: vpnItem.name,
          owningAccountId: accountId,
          transitGatewayId,
          type: TransitGatewayAttachmentType.VPN,
          kmsKey: this.cloudwatchKey,
          logRetentionInDays: this.logRetention,
        },
      ).transitGatewayAttachmentId;
      // Add to Transit Gateway Attachment Map
      this.transitGatewayAttachments.set(`${vpnItem.name}_${tgw.name}`, vpnAttachmentId);
    }
  }

  /**
   * Create VPN TGW route table associations
   * @param cgwItem
   * @param vpnItem
   */
  private createVpnTransitGatewayAssociations(cgwItem: CustomerGatewayConfig, vpnItem: VpnConnectionConfig): void {
    const accountId = this.props.accountsConfig.getAccountId(cgwItem.account);
    if (
      accountId === cdk.Stack.of(this).account &&
      cgwItem.region === cdk.Stack.of(this).region &&
      vpnItem.routeTableAssociations
    ) {
      // Lookup TGW attachment ID for VPN
      const attachmentKey = `${vpnItem.name}_${vpnItem.transitGateway}`;
      const transitGatewayAttachmentId = this.transitGatewayAttachments.get(attachmentKey);

      if (!transitGatewayAttachmentId) {
        this.logger.error(`Transit Gateway attachment ${attachmentKey} not found`);
        throw new Error(`Configuration validation failed at runtime.`);
      }

      // Create route table associations
      for (const routeTableItem of vpnItem.routeTableAssociations ?? []) {
        const routeTableKey = `${vpnItem.transitGateway}_${routeTableItem}`;
        const transitGatewayRouteTableId = this.transitGatewayRouteTables.get(routeTableKey);

        if (!transitGatewayRouteTableId) {
          this.logger.error(`Transit Gateway Route Table ${routeTableKey} not found`);
          throw new Error(`Configuration validation failed at runtime.`);
        }

        new TransitGatewayRouteTableAssociation(
          this,
          `${pascalCase(vpnItem.name)}${pascalCase(routeTableItem)}Association`,
          {
            transitGatewayAttachmentId,
            transitGatewayRouteTableId,
          },
        );
      }
    }
  }

  /**
   * Create VPN TGW route table propagations
   * @param cgwItem
   * @param vpnItem
   */
  private createVpnTransitGatewayPropagations(cgwItem: CustomerGatewayConfig, vpnItem: VpnConnectionConfig): void {
    const accountId = this.props.accountsConfig.getAccountId(cgwItem.account);
    if (
      accountId === cdk.Stack.of(this).account &&
      cgwItem.region === cdk.Stack.of(this).region &&
      vpnItem.routeTablePropagations
    ) {
      // Lookup TGW attachment ID for VPN
      const attachmentKey = `${vpnItem.name}_${vpnItem.transitGateway}`;
      const transitGatewayAttachmentId = this.transitGatewayAttachments.get(attachmentKey);

      if (!transitGatewayAttachmentId) {
        this.logger.error(`Transit Gateway attachment ${attachmentKey} not found`);
        throw new Error(`Configuration validation failed at runtime.`);
      }

      // Create route table propagations
      for (const routeTableItem of vpnItem.routeTablePropagations ?? []) {
        const routeTableKey = `${vpnItem.transitGateway}_${routeTableItem}`;
        const transitGatewayRouteTableId = this.transitGatewayRouteTables.get(routeTableKey);

        if (!transitGatewayRouteTableId) {
          this.logger.error(`Transit Gateway Route Table ${routeTableKey} not found`);
          throw new Error(`Configuration validation failed at runtime.`);
        }

        new TransitGatewayRouteTablePropagation(
          this,
          `${pascalCase(vpnItem.name)}${pascalCase(routeTableItem)}Propagation`,
          {
            transitGatewayAttachmentId,
            transitGatewayRouteTableId,
          },
        );
      }
    }
  }

  /**
   * Function to get zone association account ids
   * @returns string[]
   *
   * @remarks
   * Generate list of accounts with VPCs that needed to set up share.
   */
  private createZoneAssociationAccountIdList(): string[] {
    // Generate list of accounts with VPCs that needed to set up share
    const zoneAssociationAccountIds: string[] = [];
    for (const vpcItem of this.vpcResources) {
      // Get account IDs
      const vpcAccountIds = this.getVpcAccountIds(vpcItem);

      if (vpcItem.region === cdk.Stack.of(this).region && vpcItem.useCentralEndpoints) {
        for (const accountId of vpcAccountIds) {
          if (!zoneAssociationAccountIds.includes(accountId)) {
            zoneAssociationAccountIds.push(accountId);
          }
        }
      }
    }

    return zoneAssociationAccountIds;
  }

  /**
   * Function to create hosted zone id list from SSM parameters
   * @param centralEndpointVpc {@link VpcConfig}
   * @returns string[]
   *
   */
  private createHostedZoneIdList(centralEndpointVpc: VpcConfig): string[] {
    const hostedZoneIds: string[] = [];
    for (const endpointItem of centralEndpointVpc.interfaceEndpoints?.endpoints ?? []) {
      const hostedZoneId = cdk.aws_ssm.StringParameter.valueForStringParameter(
        this,
        this.getSsmPath(SsmResourceType.PHZ_ID, [centralEndpointVpc.name, endpointItem.service]),
      );
      hostedZoneIds.push(hostedZoneId);
    }

    return hostedZoneIds;
  }

  /**
   * Create Route 53 private hosted zone associations for centralized interface endpoints
   */
  private createHostedZoneAssociations(): void {
    // Get Central end point vpc
    const centralEndpointVpc = this.getCentralEndpointVpc();

    if (centralEndpointVpc) {
      this.logger.info('Central endpoints VPC detected, share private hosted zone with member VPCs');

      // Generate list of accounts with VPCs that needed to set up share
      const zoneAssociationAccountIds = this.createZoneAssociationAccountIdList();

      // Create list of hosted zone ids from SSM Params
      const hostedZoneIds = this.createHostedZoneIdList(centralEndpointVpc);

      // Custom resource to associate hosted zones
      new AssociateHostedZones(this, 'AssociateHostedZones', {
        accountIds: zoneAssociationAccountIds,
        hostedZoneIds,
        hostedZoneAccountId: cdk.Stack.of(this).account,
        roleName: `${this.props.prefixes.accelerator}-EnableCentralEndpointsRole-${cdk.Stack.of(this).region}`,
        tagFilters: [
          {
            key: 'accelerator:use-central-endpoints',
            value: 'true',
          },
          {
            key: 'accelerator:central-endpoints-account-id',
            value: this.props.accountsConfig.getAccountId(centralEndpointVpc.account),
          },
        ],
        kmsKey: this.cloudwatchKey,
        logRetentionInDays: this.logRetention,
      });
    }
  }

  /**
   * Create central network service associations
   * @param props
   */
  private createCentralNetworkAssociations(props: AcceleratorStackProps) {
    //
    // Create Route 53 Resolver VPC associations
    //
    if (props.networkConfig.centralNetworkServices) {
      for (const vpcItem of this.vpcResources) {
        // Get account IDs
        const vpcAccountIds = this.getVpcAccountIds(vpcItem);
        const delegatedAdminAccountId = this.props.accountsConfig.getAccountId(
          props.networkConfig.centralNetworkServices.delegatedAdminAccount,
        );
        if (this.isTargetStack(vpcAccountIds, [vpcItem.region])) {
          this.createDnsFirewallAssociations(vpcItem, delegatedAdminAccountId);
          this.createQueryLogConfigAssociations(vpcItem, delegatedAdminAccountId);
          this.createResolverRuleAssociations(vpcItem, delegatedAdminAccountId);
        }
      }
    }
  }

  /**
   * Create local VPC Route53 Resources
   * @param props
   */
  private createRoute53LocalVpcResources(props: AcceleratorStackProps) {
    for (const vpcItem of props.networkConfig.vpcs) {
      const vpcAccountIds = this.getVpcAccountIds(vpcItem);
      if (this.isTargetStack(vpcAccountIds, [vpcItem.region])) {
        const accountId = cdk.Stack.of(this).account;
        this.createVpcQueryLogConfigAssociations(vpcItem, accountId);
      }
    }
  }
  /**
   * Create Route 53 Resolver DNS Firewall VPC associations
   * @param vpcItem
   * @param owningAccountId
   */
  private createDnsFirewallAssociations(vpcItem: VpcConfig | VpcTemplatesConfig, owningAccountId: string): void {
    for (const firewallItem of vpcItem.dnsFirewallRuleGroups ?? []) {
      // Get VPC ID
      const vpcId = cdk.aws_ssm.StringParameter.valueForStringParameter(
        this,
        this.getSsmPath(SsmResourceType.VPC, [vpcItem.name]),
      );

      // Skip lookup if already added to map
      if (!this.dnsFirewallMap.has(firewallItem.name)) {
        // Get SSM parameter if this is the owning account
        if (owningAccountId === cdk.Stack.of(this).account) {
          const ruleId = cdk.aws_ssm.StringParameter.valueForStringParameter(
            this,
            this.getSsmPath(SsmResourceType.DNS_RULE_GROUP, [firewallItem.name]),
          );
          this.dnsFirewallMap.set(firewallItem.name, ruleId);
        } else {
          // Get ID from the resource share
          const ruleId = this.getResourceShare(
            `${firewallItem.name}_ResolverFirewallRuleGroupShare`,
            'route53resolver:FirewallRuleGroup',
            owningAccountId,
            this.cloudwatchKey,
          ).resourceShareItemId;
          this.dnsFirewallMap.set(firewallItem.name, ruleId);
        }
      }

      // Create association
      if (!this.dnsFirewallMap.get(firewallItem.name)) {
        this.logger.error(`Could not find existing DNS firewall rule group ${firewallItem.name}`);
        throw new Error(`Configuration validation failed at runtime.`);
      }
      this.logger.info(`Add DNS firewall rule group ${firewallItem.name} to ${vpcItem.name}`);

      new ResolverFirewallRuleGroupAssociation(
        this,
        pascalCase(`${vpcItem.name}${firewallItem.name}RuleGroupAssociation`),
        {
          firewallRuleGroupId: this.dnsFirewallMap.get(firewallItem.name)!,
          priority: firewallItem.priority,
          vpcId: vpcId,
          mutationProtection: firewallItem.mutationProtection,
          tags: firewallItem.tags,
        },
      );
    }
  }

  /**
   * Create Query logging config association map
   * @param vpcItem {@link VpcConfig} | {@link VpcTemplatesConfig}
   * @param vpcId string
   * @param configNames string[]
   */
  private createQueryLoggingConfigAssociation(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    vpcId: string,
    configNames: string[],
  ): void {
    // Create association
    for (const nameItem of configNames) {
      if (this.isManagedByAsea(AseaResourceType.ROUTE_53_QUERY_LOGGING_ASSOCIATION, vpcItem.name)) {
        this.logger.info(
          `Route 53 Query Logging is already associated with VPC "${vpcItem.name}" and is managed externally.`,
        );
        break;
      } else if (!this.queryLogMap.get(nameItem)) {
        this.logger.error(`Could not find existing DNS query log config ${nameItem}`);
        throw new Error(`Configuration validation failed at runtime.`);
      } else {
        this.logger.info(`Add DNS query log config ${nameItem} to ${vpcItem.name}`);
        new QueryLoggingConfigAssociation(this, pascalCase(`${vpcItem.name}${nameItem}QueryLogAssociation`), {
          resolverQueryLogConfigId: this.queryLogMap.get(nameItem),
          vpcId: vpcId,
          partition: this.props.partition,
          kmsKey: this.cloudwatchKey,
          logRetentionInDays: this.logRetention,
        });
      }
    }
  }

  /**
   * Function to create query log map
   * @param configNames string[]
   * @param owningAccountId string
   */
  private createQueryLogMap(configNames: string[], owningAccountId: string): void {
    // Get SSM parameter if this is the owning account
    for (const nameItem of configNames) {
      // Skip lookup if already added to map
      if (!this.queryLogMap.has(nameItem)) {
        if (owningAccountId === cdk.Stack.of(this).account) {
          if (this.isManagedByAsea(AseaResourceType.ROUTE_53_QUERY_LOGGING, nameItem.replace('-cwl', ''))) {
            this.logger.info(`DNS Logging for VPC "${nameItem.replace('-cwl', '')}" is managed externally`);
            break;
          }
          const configId = cdk.aws_ssm.StringParameter.valueForStringParameter(
            this,
            this.getSsmPath(SsmResourceType.QUERY_LOGS, [nameItem]),
          );
          this.queryLogMap.set(nameItem, configId);
        } else {
          // Get ID from the resource share
          const configId = this.getResourceShare(
            `${nameItem}_QueryLogConfigShare`,
            'route53resolver:ResolverQueryLogConfig',
            owningAccountId,
            this.cloudwatchKey,
          ).resourceShareItemId;
          this.queryLogMap.set(nameItem, configId);
        }
      }
    }
  }

  /**
   * Create Route 53 Resolver query log config VPC associations
   * @param vpcItem
   * @param owningAccountId
   */
  private createQueryLogConfigAssociations(vpcItem: VpcConfig | VpcTemplatesConfig, owningAccountId: string): void {
    for (const configItem of vpcItem.queryLogs ?? []) {
      // Get VPC ID
      const vpcId = cdk.aws_ssm.StringParameter.valueForStringParameter(
        this,
        this.getSsmPath(SsmResourceType.VPC, [vpcItem.name]),
      );

      // Determine query log destination(s)
      const centralNetworkConfig = this.props.networkConfig.centralNetworkServices!;
      const configNames: string[] = [];
      if (centralNetworkConfig.route53Resolver?.queryLogs?.destinations.includes('s3')) {
        configNames.push(`${configItem}-s3`);
      }
      if (centralNetworkConfig.route53Resolver?.queryLogs?.destinations.includes('cloud-watch-logs')) {
        configNames.push(`${configItem}-cwl`);
      }

      this.createQueryLogMap(configNames, owningAccountId);

      // Create association
      this.createQueryLoggingConfigAssociation(vpcItem, vpcId, configNames);
    }
  }

  private createVpcQueryLogConfigAssociations(vpcItem: VpcConfig, owningAccountId: string) {
    if (vpcItem.vpcRoute53Resolver?.queryLogs?.name) {
      // Get VPC ID
      const vpcId = cdk.aws_ssm.StringParameter.valueForStringParameter(
        this,
        this.getSsmPath(SsmResourceType.VPC, [vpcItem.name]),
      );
      // Determine query log destination(s)
      const configItem = vpcItem.vpcRoute53Resolver?.queryLogs.name;
      const vpcConfig = vpcItem.vpcRoute53Resolver!;
      const configNames: string[] = [];
      if (vpcConfig.queryLogs?.destinations.includes('s3')) {
        configNames.push(`${configItem}-s3`);
      }
      if (vpcConfig.queryLogs?.destinations.includes('cloud-watch-logs')) {
        configNames.push(`${configItem}-cwl`);
      }

      this.createQueryLogMap(configNames, owningAccountId);

      // Create association
      this.createQueryLoggingConfigAssociation(vpcItem, vpcId, configNames);
    }
  }

  /**
   * Create Route 53 Resolver rule VPC associations
   * @param vpcItem
   * @param owningAccountId
   */
  private createResolverRuleAssociations(vpcItem: VpcConfig | VpcTemplatesConfig, owningAccountId: string): void {
    for (const ruleItem of vpcItem.resolverRules ?? []) {
      // Get VPC ID
      const vpcId = cdk.aws_ssm.StringParameter.valueForStringParameter(
        this,
        this.getSsmPath(SsmResourceType.VPC, [vpcItem.name]),
      );

      // Skip lookup if already added to map
      if (!this.resolverRuleMap.has(ruleItem)) {
        // Get SSM parameter if this is the owning account
        if (owningAccountId === cdk.Stack.of(this).account) {
          const ruleId = cdk.aws_ssm.StringParameter.valueForStringParameter(
            this,
            this.getSsmPath(SsmResourceType.RESOLVER_RULE, [ruleItem]),
          );
          this.resolverRuleMap.set(ruleItem, ruleId);
        } else {
          // Get ID from the resource share
          const ruleId = this.getResourceShare(
            `${ruleItem}_ResolverRule`,
            'route53resolver:ResolverRule',
            owningAccountId,
            this.cloudwatchKey,
          ).resourceShareItemId;
          this.resolverRuleMap.set(ruleItem, ruleId);
        }
      }

      // Create association
      if (!this.resolverRuleMap.get(ruleItem)) {
        this.logger.error(`Could not find existing Route 53 Resolver rule ${ruleItem}`);
        throw new Error(`Configuration validation failed at runtime.`);
      }
      this.logger.info(`Add Route 53 Resolver rule ${ruleItem} to ${vpcItem.name}`);
      new ResolverRuleAssociation(this, pascalCase(`${vpcItem.name}${ruleItem}RuleAssociation`), {
        resolverRuleId: this.resolverRuleMap.get(ruleItem)!,
        vpcId: vpcId,
      });
    }
  }

  /**
   * Create VPC peering connections
   */
  private createVpcPeeringConnections(): void {
    // Create VPC peering connections
    for (const peering of this.peeringList) {
      // Get account IDs
      const accepterAccountIds = this.getVpcAccountIds(peering.accepter);

      // Get SSM parameters
      const requesterVpcId = cdk.aws_ssm.StringParameter.valueForStringParameter(
        this,
        this.getSsmPath(SsmResourceType.VPC, [peering.requester.name]),
      );

      let vpcPeering;
      let aseaPeerMappingName = peering.name;
      let peeringConstructId = `${peering.name}VpcPeering`;
      let vpcPeerSsmConstructId = `SsmParam${pascalCase(peering.name)}VpcPeering`;

      for (const accepterAccountId of accepterAccountIds) {
        let accepterVpcId: string;
        let accepterRoleName: string | undefined = undefined;
        if (peering.crossAccount && accepterAccountId !== this.account) {
          accepterVpcId = new SsmParameterLookup(this, pascalCase(`SsmParamLookup${peering.name}`), {
            name: this.getSsmPath(SsmResourceType.VPC, [peering.accepter.name]),
            accountId: accepterAccountId,
            parameterRegion: peering.accepter.region,
            roleName: `${this.props.prefixes.accelerator}-VpcPeeringRole-${peering.accepter.region}`,
            kmsKey: this.cloudwatchKey,
            logRetentionInDays: this.logRetention,
            acceleratorPrefix: this.props.prefixes.accelerator,
          }).value;

          accepterRoleName = `${this.props.prefixes.accelerator}-VpcPeeringRole-${peering.accepter.region}`;
        } else {
          accepterVpcId = cdk.aws_ssm.StringParameter.valueForStringParameter(
            this,
            this.getSsmPath(SsmResourceType.VPC, [peering.accepter.name]),
          );
        }
        if (
          // isNetworkType<VpcTemplatesConfig>('IVpcTemplatesConfig', peering.requester) ||
          isNetworkType<VpcTemplatesConfig>('IVpcTemplatesConfig', peering.accepter)
        ) {
          aseaPeerMappingName = `${peering.name}_${accepterAccountId}`;
          peeringConstructId = `${peering.name}VpcPeering${accepterAccountId}`;
          vpcPeerSsmConstructId = `SsmParam${pascalCase(peering.name)}VpcPeering${accepterAccountId}`;
        }
        if (this.isManagedByAsea(AseaResourceType.EC2_VPC_PEERING, peering.name)) {
          const peeringId = this.getExternalResourceParameter(
            this.getSsmPath(SsmResourceType.VPC_PEERING, [aseaPeerMappingName]),
          );
          vpcPeering = VpcPeering.fromPeeringAttributes(this, peeringConstructId, {
            name: peering.name,
            peeringId: peeringId,
          });
        } else {
          // Create VPC peering
          this.logger.info(
            `Create VPC peering ${peering.name} between ${peering.requester.name} and ${peering.accepter.name}`,
          );
          vpcPeering = new VpcPeering(this, peeringConstructId, {
            name: peering.name,
            peerOwnerId: accepterAccountId,
            peerRegion: peering.accepter.region,
            peerVpcId: accepterVpcId,
            peerRoleName: accepterRoleName,
            vpcId: requesterVpcId,
            tags: peering.tags ?? [],
          });
          this.ssmParameters.push({
            logicalId: pascalCase(vpcPeerSsmConstructId),
            parameterName: this.getSsmPath(SsmResourceType.VPC_PEERING, [
              isNetworkType<VpcTemplatesConfig>('IVpcTemplatesConfig', peering.accepter)
                ? // There will be multiple peering connections in requester account if accepter is VpcTemplate. Add accepterAccountId to avoid duplicate ssm parameter name
                  `${peering.name}/${accepterAccountId}`
                : peering.name,
            ]),
            stringValue: vpcPeering.peeringId,
          });
        }

        // Put cross-account SSM parameter if necessary
        if (peering.crossAccount && accepterAccountId !== this.account) {
          new PutSsmParameter(this, pascalCase(`CrossAcctSsmParam${pascalCase(peering.name)}VpcPeering`), {
            accountIds: [accepterAccountId],
            region: peering.accepter.region,
            roleName: this.acceleratorResourceNames.roles.crossAccountSsmParameterShare,
            kmsKey: this.cloudwatchKey,
            logRetentionInDays: this.logRetention,
            parameters: [
              {
                name: this.getSsmPath(SsmResourceType.VPC_PEERING, [peering.name]),
                value: vpcPeering.peeringId,
              },
            ],
            invokingAccountId: cdk.Stack.of(this).account,
            acceleratorPrefix: this.props.prefixes.accelerator,
          });
        }

        // Create peering routes
        this.createVpcPeeringRoutes(accepterAccountId, peering.requester, peering.accepter, vpcPeering);
      }
    }
  }

  /**
   * Create VPC peering routes
   * @param accepterAccountId
   * @param requesterVpc
   * @param accepterVpc
   * @param peering
   */
  private createVpcPeeringRoutes(
    accepterAccountId: string,
    requesterVpc: VpcConfig | VpcTemplatesConfig,
    accepterVpc: VpcConfig | VpcTemplatesConfig,
    peering: VpcPeering,
  ): void {
    // Create requester VPC routes
    this.createRequesterVpcPeeringRoutes(requesterVpc, accepterVpc, accepterAccountId, peering);

    // Create accepter account routes
    this.createAccepterVpcPeeringRoutes(accepterAccountId, accepterVpc, requesterVpc, peering);
  }

  /**
   * Function to add requester peering route
   * @param requesterVpc {@link VpcConfig}
   * @param accepterVpc {@link VpcConfig}
   * @param accepterAccountId
   * @param peering {@link VpcPeering}
   * @param routeTable {@link RouteTableConfig}
   * @param routeTableEntry {@link RouteTableEntryConfig}
   */
  private addRequesterPeeringRoute(
    requesterVpc: VpcConfig | VpcTemplatesConfig,
    accepterVpc: VpcConfig | VpcTemplatesConfig,
    accepterAccountId: string,
    peering: VpcPeering,
    routeTable: RouteTableConfig,
    routeTableEntry: RouteTableEntryConfig,
  ): void {
    if (routeTableEntry.type && routeTableEntry.type === 'vpcPeering' && routeTableEntry.target === peering.name) {
      this.logger.info(`Add route ${routeTableEntry.name} targeting VPC peer ${peering.name}`);
      const routeTableId = this.routeTableMap.get(`${requesterVpc.name}_${routeTable.name}`);
      const routeId =
        pascalCase(`${requesterVpc.name}Vpc`) +
        pascalCase(`${routeTable.name}RouteTable`) +
        pascalCase(routeTableEntry.name);
      if (!routeTableId) {
        this.logger.error(`Route Table ${routeTable.name} not found`);
        throw new Error(`Configuration validation failed at runtime.`);
      }

      const requesterPeeringRouteDetails = this.getRequesterPeeringRouteDestinationConfig(
        accepterVpc,
        accepterAccountId,
        routeTableEntry,
      );

      peering.addPeeringRoute(
        routeId,
        routeTableId,
        requesterPeeringRouteDetails.destination,
        requesterPeeringRouteDetails.destinationPrefixListId,
        requesterPeeringRouteDetails.ipv6Destination,
        this.cloudwatchKey,
        this.logRetention,
      );
    }
  }

  /**
   * Create requester peering routes
   * @param requesterVpc
   * @param accepterVpc
   * @param accepterAccountId
   * @param peering
   */
  private createRequesterVpcPeeringRoutes(
    requesterVpc: VpcConfig | VpcTemplatesConfig,
    accepterVpc: VpcConfig | VpcTemplatesConfig,
    accepterAccountId: string,
    peering: VpcPeering,
  ): void {
    for (const routeTable of requesterVpc.routeTables ?? []) {
      for (const routeTableEntry of routeTable.routes ?? []) {
        this.addRequesterPeeringRoute(
          requesterVpc,
          accepterVpc,
          accepterAccountId,
          peering,
          routeTable,
          routeTableEntry,
        );
      }
    }
  }

  /**
   * Function to get accepter peering route destination configuration
   * @param accepterVpc {@link VpcConfig}
   * @param requesterVpc {@link VpcConfig}
   * @param accepterAccountId
   * @param routeTableEntry {@link RouteTableEntryConfig}
   * @returns
   */
  private getAccepterPeeringRouteDestinationConfig(
    accepterVpc: VpcConfig | VpcTemplatesConfig,
    requesterVpc: VpcConfig | VpcTemplatesConfig,
    accepterAccountId: string,
    routeTableEntry: RouteTableEntryConfig,
  ): { destinationPrefixListId?: string; destination?: string; ipv6Destination?: string } {
    let destination: string | undefined = undefined;
    let destinationPrefixListId: string | undefined = undefined;
    const requesterAccountIds = this.getVpcAccountIds(requesterVpc);
    let ipv6Destination: string | undefined = undefined;
    if (requesterAccountIds.includes(accepterAccountId) && requesterVpc.region === accepterVpc.region) {
      if (routeTableEntry.destinationPrefixList) {
        // Get PL ID from map
        destinationPrefixListId = this.prefixListMap.get(routeTableEntry.destinationPrefixList);
        if (!destinationPrefixListId) {
          this.logger.error(`Prefix list ${routeTableEntry.destinationPrefixList} not found`);
          throw new Error(`Configuration validation failed at runtime.`);
        }
      } else if (routeTableEntry.destination || routeTableEntry.ipv6Destination) {
        destination = routeTableEntry.destination;
        ipv6Destination = routeTableEntry.ipv6Destination;
      } else {
        destination = this.getVpcCidr(requesterVpc, this.account);
      }
    } else {
      if (routeTableEntry.destinationPrefixList) {
        // Get PL ID from map
        destinationPrefixListId = this.prefixListMap.get(
          `${accepterAccountId}_${accepterVpc.region}_${routeTableEntry.destinationPrefixList}`,
        );
      } else if (routeTableEntry.destination || routeTableEntry.ipv6Destination) {
        destination = routeTableEntry.destination;
        ipv6Destination = routeTableEntry.ipv6Destination;
      } else {
        destination = this.getVpcCidr(requesterVpc, this.account);
      }
    }
    return { destinationPrefixListId: destinationPrefixListId, destination, ipv6Destination };
  }

  /**
   * Function to get accepter peering route destination configuration
   * @param accepterVpc {@link VpcConfig}
   * @param accepterAccountId
   * @param routeTableEntry {@link RouteTableEntryConfig}
   * @returns
   */
  private getRequesterPeeringRouteDestinationConfig(
    accepterVpc: VpcConfig | VpcTemplatesConfig,
    accepterAccountId: string,
    routeTableEntry: RouteTableEntryConfig,
  ): {
    destinationPrefixListId?: string;
    destination?: string;
    ipv6Destination?: string;
  } {
    let destination: string | undefined = undefined;
    let destinationPrefixListId: string | undefined = undefined;
    let ipv6Destination: string | undefined = undefined;
    if (routeTableEntry.destinationPrefixList) {
      // Get PL ID from map
      destinationPrefixListId = getPrefixList(this.prefixListMap, routeTableEntry.destinationPrefixList) as string;
    } else if (routeTableEntry.destination || routeTableEntry.ipv6Destination) {
      destination = routeTableEntry.destination;
      ipv6Destination = routeTableEntry.ipv6Destination;
    } else {
      destination = this.getVpcCidr(accepterVpc, accepterAccountId);
    }

    return { destinationPrefixListId, destination, ipv6Destination };
  }

  /**
   * Function to create accepter peering route
   * @param accepterAccountId string
   * @param accepterVpc {@link VpcConfig}
   * @param requesterVpc {@link VpcConfig}
   * @param peering {@link VpcPeering}
   * @param routeTableEntry {@link RouteTableEntryConfig}
   * @param routeId string
   * @param routeTableId string
   */
  private createAccepterPeeringRoute(
    accepterAccountId: string,
    accepterVpc: VpcConfig | VpcTemplatesConfig,
    requesterVpc: VpcConfig | VpcTemplatesConfig,
    peering: VpcPeering,
    routeTableEntry: RouteTableEntryConfig,
    routeId: string,
    routeTableId: string,
  ): void {
    const accepterPeeringRouteDestinationConfig = this.getAccepterPeeringRouteDestinationConfig(
      accepterVpc,
      requesterVpc,
      accepterAccountId,
      routeTableEntry,
    );
    const destination = accepterPeeringRouteDestinationConfig.destination;
    const destinationPrefixListId = accepterPeeringRouteDestinationConfig.destinationPrefixListId;
    const ipv6Destination = accepterPeeringRouteDestinationConfig.ipv6Destination;

    if (this.account === accepterAccountId && requesterVpc.region === accepterVpc.region) {
      peering.addPeeringRoute(
        routeId,
        routeTableId,
        destination,
        destinationPrefixListId,
        ipv6Destination,
        this.cloudwatchKey,
        this.logRetention,
      );
    } else {
      if (!this.crossAcctRouteProvider) {
        this.logger.error(`Cross-account route provider not created but required for ${routeTableEntry.name}`);
        throw new Error(`Configuration validation failed at runtime.`);
      }

      peering.addCrossAcctPeeringRoute({
        id: routeId,
        ownerAccount: accepterAccountId,
        ownerRegion: accepterVpc.region,
        partition: this.props.partition,
        provider: this.crossAcctRouteProvider,
        roleName: `${this.props.prefixes.accelerator}-VpcPeeringRole-${accepterVpc.region}`,
        routeTableId,
        destination,
        destinationPrefixListId,
        ipv6Destination,
      });
    }
  }

  /**
   * Create accepter VPC routes
   * @param accepterAccountId
   * @param accepterVpc
   * @param requesterVpc
   * @param peering
   */
  private createAccepterVpcPeeringRoutes(
    accepterAccountId: string,
    accepterVpc: VpcConfig | VpcTemplatesConfig,
    requesterVpc: VpcConfig | VpcTemplatesConfig,
    peering: VpcPeering,
  ): void {
    for (const routeTable of accepterVpc.routeTables ?? []) {
      for (const routeTableEntry of routeTable.routes ?? []) {
        if (routeTableEntry.type && routeTableEntry.type === 'vpcPeering' && routeTableEntry.target === peering.name) {
          this.logger.info(`Add route ${routeTableEntry.name} targeting VPC peer ${peering.name}`);

          const routeId =
            pascalCase(`${accepterVpc.name}Vpc`) +
            pascalCase(`${routeTable.name}RouteTable`) +
            pascalCase(routeTableEntry.name);
          const routeTableId = this.routeTableMap.get(
            requesterVpc.region !== accepterVpc.region || this.account !== accepterAccountId
              ? `${accepterVpc.name}_${accepterAccountId}_${routeTable.name}`
              : `${accepterVpc.name}_${routeTable.name}`,
          );
          if (!routeTableId) {
            this.logger.error(`Route Table ${routeTable.name} not found`);
            throw new Error(`Configuration validation failed at runtime.`);
          }

          this.createAccepterPeeringRoute(
            accepterAccountId,
            accepterVpc,
            requesterVpc,
            peering,
            routeTableEntry,
            routeId,
            routeTableId,
          );
        }
      }
    }
  }

  /**
   * Function to create Dx TGW route table associations and propagations
   * @param associationItem {@link DxTransitGatewayAssociationConfig}
   * @param tgw {@link TransitGatewayConfig}
   * @param tgwAccountId string
   * @param dxgwItem {@link DxGatewayConfig}
   *
   * @remarks
   * Create transit gateway route table associations and propagations for DX Gateway attachments
   */
  private createDxTgwRouteTableAssociationsAndPropagations(
    associationItem: DxTransitGatewayAssociationConfig,
    tgw: TransitGatewayConfig,
    tgwAccountId: string,
    dxgwItem: DxGatewayConfig,
  ): void {
    for (const routeTableAssociationItem of associationItem.routeTableAssociations ?? []) {
      this.createDxTgwRouteTableAssociations(dxgwItem, tgw, routeTableAssociationItem, tgwAccountId);
    }
    for (const routeTablePropagationItem of associationItem.routeTablePropagations ?? []) {
      this.createDxTgwRouteTablePropagations(dxgwItem, tgw, routeTablePropagationItem, tgwAccountId);
    }
  }

  /**
   * Create Direct Connect resources
   * @param props
   */
  private createDirectConnectResources(props: AcceleratorStackProps) {
    for (const dxgwItem of props.networkConfig.directConnectGateways ?? []) {
      for (const associationItem of dxgwItem.transitGatewayAssociations ?? []) {
        const tgw = props.networkConfig.transitGateways.find(
          item => item.name === associationItem.name && item.account === associationItem.account,
        );
        if (!tgw) {
          this.logger.error(`Unable to locate transit gateway ${associationItem.name}`);
          throw new Error(`Configuration validation failed at runtime.`);
        }
        const tgwAccountId = this.props.accountsConfig.getAccountId(tgw.account);
        //
        // Set DX Gateway ID map
        //
        this.setDxGatewayMap(dxgwItem, tgw, tgwAccountId);
        //
        // Create DX Gateway associations to transit gateways
        //
        this.createDxGatewayTgwAssociations(dxgwItem, tgw, associationItem, tgwAccountId);
        //
        // Create transit gateway route table associations
        // and propagations for DX Gateway attachments
        //
        this.createDxTgwRouteTableAssociationsAndPropagations(associationItem, tgw, tgwAccountId, dxgwItem);
      }
    }
  }

  /**
   * Set Direct Connect Gateway map
   * @param dxgwItem
   */
  private setDxGatewayMap(dxgwItem: DxGatewayConfig, tgw: TransitGatewayConfig, tgwAccountId: string): void {
    // If DX gateway and transit gateway accounts differ, get cross-account SSM parameter
    if (dxgwItem.account !== tgw.account && this.isTargetStack([tgwAccountId], [tgw.region])) {
      const directConnectGatewayOwnerAccount = this.props.accountsConfig.getAccountId(dxgwItem.account);
      const dxgwId = new SsmParameterLookup(this, pascalCase(`SsmParamLookup${dxgwItem.name}`), {
        name: this.getSsmPath(SsmResourceType.DXGW, [dxgwItem.name]),
        accountId: directConnectGatewayOwnerAccount,
        parameterRegion: this.props.globalConfig.homeRegion,
        roleName: `${this.props.prefixes.accelerator}-Get${pascalCase(dxgwItem.name)}SsmParamRole-${
          this.props.globalConfig.homeRegion
        }`,
        kmsKey: this.cloudwatchKey,
        logRetentionInDays: this.logRetention,
        acceleratorPrefix: this.props.prefixes.accelerator,
      }).value;
      this.dxGatewayMap.set(dxgwItem.name, dxgwId);
    }

    // If DX gateway and transit gateway accounts match, get local SSM parameter
    if (dxgwItem.account === tgw.account && this.isTargetStack([tgwAccountId], [tgw.region])) {
      if (tgw.region === this.props.globalConfig.homeRegion) {
        const dxgwId = cdk.aws_ssm.StringParameter.valueForStringParameter(
          this,
          this.getSsmPath(SsmResourceType.DXGW, [dxgwItem.name]),
        );
        this.dxGatewayMap.set(dxgwItem.name, dxgwId);
      } else {
        const dxgwId = new SsmParameterLookup(this, pascalCase(`SsmParamLookup${dxgwItem.name}`), {
          name: this.getSsmPath(SsmResourceType.DXGW, [dxgwItem.name]),
          accountId: cdk.Stack.of(this).account,
          parameterRegion: this.props.globalConfig.homeRegion,
          roleName: `${this.props.prefixes.accelerator}-Get${pascalCase(dxgwItem.name)}SsmParamRole-${
            this.props.globalConfig.homeRegion
          }`,
          kmsKey: this.cloudwatchKey,
          logRetentionInDays: this.logRetention,
          acceleratorPrefix: this.props.prefixes.accelerator,
        }).value;
        this.dxGatewayMap.set(dxgwItem.name, dxgwId);
      }
    }
  }

  /**
   * Function to create DirectConnect Gateway Association
   * @param dxgwItem {@link DxGatewayConfig}
   * @param tgwItem {@link TransitGatewayConfig}
   * @param createAssociation boolean
   * @param associationLogicalId string
   * @param associationProps {@link DirectConnectGatewayAssociationProps}
   */
  private createDirectConnectGatewayAssociation(
    dxgwItem: DxGatewayConfig,
    tgwItem: TransitGatewayConfig,
    createAssociation: boolean,
    associationLogicalId?: string,
    associationProps?: DirectConnectGatewayAssociationProps,
  ): void {
    if (createAssociation) {
      if (!associationLogicalId || !associationProps) {
        this.logger.error(
          `Create DX Gateway associations: unable to process properties for association between DX Gateway ${dxgwItem.name} and transit gateway ${tgwItem.name}`,
        );
        throw new Error(`Configuration validation failed at runtime.`);
      }
      const association = new DirectConnectGatewayAssociation(this, associationLogicalId, associationProps);
      // Add attachment ID to map if exists
      if (association.transitGatewayAttachmentId) {
        this.transitGatewayAttachments.set(`${dxgwItem.name}_${tgwItem.name}`, association.transitGatewayAttachmentId);
      }
    }
  }

  /**
   * Create Direct Connect Gateway associations to transit gateways
   * @param dxgw
   * @param tgw
   * @param associationItem
   * @param tgwAccountId
   */
  private createDxGatewayTgwAssociations(
    dxgwItem: DxGatewayConfig,
    tgw: TransitGatewayConfig,
    associationItem: DxTransitGatewayAssociationConfig,
    tgwAccountId: string,
  ): void {
    // Condition-based variables
    let createAssociation = false;
    let associationLogicalId: string | undefined = undefined;
    let associationProps: DirectConnectGatewayAssociationProps | undefined = undefined;

    // If DX gateway and transit gateway accounts differ, create association proposal
    if (dxgwItem.account !== tgw.account && this.isTargetStack([tgwAccountId], [tgw.region])) {
      this.logger.info(
        `Creating association proposal between DX Gateway ${dxgwItem.name} and transit gateway ${tgw.name}`,
      );
      createAssociation = true;
      const directConnectGatewayId = this.dxGatewayMap.get(dxgwItem.name);
      const directConnectGatewayOwnerAccount = this.props.accountsConfig.getAccountId(dxgwItem.account);
      associationLogicalId = pascalCase(`${dxgwItem.name}${tgw.name}DxGatewayAssociationProposal`);
      const gatewayId = this.transitGateways.get(tgw.name);

      if (!directConnectGatewayId) {
        this.logger.error(`Create DX Gateway associations: unable to locate DX Gateway ID for ${dxgwItem.name}`);
        throw new Error(`Configuration validation failed at runtime.`);
      }
      if (!gatewayId) {
        this.logger.error(`Create DX Gateway associations: unable to locate transit gateway ID for ${tgw.name}`);
        throw new Error(`Configuration validation failed at runtime.`);
      }

      associationProps = {
        allowedPrefixes: associationItem.allowedPrefixes,
        directConnectGatewayId,
        directConnectGatewayOwnerAccount,
        gatewayId,
        kmsKey: this.cloudwatchKey,
        logRetentionInDays: this.logRetention,
        acceleratorPrefix: this.props.prefixes.accelerator,
      };
    }

    // If DX gateway and transit gateway accounts match, create association
    if (dxgwItem.account === tgw.account && this.isTargetStack([tgwAccountId], [tgw.region])) {
      this.logger.info(`Creating association between DX Gateway ${dxgwItem.name} and transit gateway ${tgw.name}`);
      createAssociation = true;
      const directConnectGatewayId = this.dxGatewayMap.get(dxgwItem.name);
      associationLogicalId = pascalCase(`${dxgwItem.name}${tgw.name}DxGatewayAssociation`);
      const gatewayId = this.transitGateways.get(tgw.name);

      if (!directConnectGatewayId) {
        this.logger.error(`Create DX Gateway associations: unable to locate DX Gateway ID for ${dxgwItem.name}`);
        throw new Error(`Configuration validation failed at runtime.`);
      }
      if (!gatewayId) {
        this.logger.error(`Create DX Gateway associations: unable to locate transit gateway ID for ${tgw.name}`);
        throw new Error(`Configuration validation failed at runtime.`);
      }

      associationProps = {
        allowedPrefixes: associationItem.allowedPrefixes,
        directConnectGatewayId,
        gatewayId,
        kmsKey: this.cloudwatchKey,
        logRetentionInDays: this.logRetention,
        acceleratorPrefix: this.props.prefixes.accelerator,
      };
    }

    this.createDirectConnectGatewayAssociation(
      dxgwItem,
      tgw,
      createAssociation,
      associationLogicalId,
      associationProps,
    );
  }

  /**
   * Create transit gateway route table associations for DX Gateway attachments
   * @param dxgwItem
   * @param tgw
   * @param tgwRouteTableName
   * @param tgwAccountId
   */
  private createDxTgwRouteTableAssociations(
    dxgwItem: DxGatewayConfig,
    tgw: TransitGatewayConfig,
    tgwRouteTableName: string,
    tgwAccountId: string,
  ): void {
    if (this.isTargetStack([tgwAccountId], [tgw.region])) {
      const transitGatewayAttachmentId = this.transitGatewayAttachments.get(`${dxgwItem.name}_${tgw.name}`);
      const transitGatewayRouteTableId = this.transitGatewayRouteTables.get(`${tgw.name}_${tgwRouteTableName}`);

      if (!transitGatewayAttachmentId) {
        this.logger.error(
          `Create DX TGW route table associations: unable to locate attachment ${dxgwItem.name}_${tgw.name}`,
        );
        throw new Error(`Configuration validation failed at runtime.`);
      }
      if (!transitGatewayRouteTableId) {
        this.logger.error(
          `Create DX TGW route table associations: unable to locate route table ${tgw.name}_${tgwRouteTableName}`,
        );
        throw new Error(`Configuration validation failed at runtime.`);
      }

      // Create association
      this.logger.info(`Creating TGW route table association to ${tgwRouteTableName} for DX Gateway ${dxgwItem.name}`);
      new TransitGatewayRouteTableAssociation(this, pascalCase(`${dxgwItem.name}${tgwRouteTableName}Association`), {
        transitGatewayAttachmentId,
        transitGatewayRouteTableId,
      });
    }
  }

  /**
   * Create transit gateway route table propagations for DX Gateway attachments
   * @param dxgwItem
   * @param tgw
   * @param tgwRouteTableName
   * @param tgwAccountId
   */
  private createDxTgwRouteTablePropagations(
    dxgwItem: DxGatewayConfig,
    tgw: TransitGatewayConfig,
    tgwRouteTableName: string,
    tgwAccountId: string,
  ): void {
    if (this.isTargetStack([tgwAccountId], [tgw.region])) {
      const transitGatewayAttachmentId = this.transitGatewayAttachments.get(`${dxgwItem.name}_${tgw.name}`);
      const transitGatewayRouteTableId = this.transitGatewayRouteTables.get(`${tgw.name}_${tgwRouteTableName}`);

      if (!transitGatewayAttachmentId) {
        this.logger.error(
          `Create DX TGW route table associations: unable to locate attachment ${dxgwItem.name}_${tgw.name}`,
        );
        throw new Error(`Configuration validation failed at runtime.`);
      }
      if (!transitGatewayRouteTableId) {
        this.logger.error(
          `Create DX TGW route table associations: unable to locate route table ${tgw.name}_${tgwRouteTableName}`,
        );
        throw new Error(`Configuration validation failed at runtime.`);
      }

      // Create association
      this.logger.info(
        `Creating TGW route table propagation for DX Gateway ${dxgwItem.name} to route table ${tgwRouteTableName}`,
      );
      new TransitGatewayRouteTablePropagation(this, pascalCase(`${dxgwItem.name}${tgwRouteTableName}Propagation`), {
        transitGatewayAttachmentId,
        transitGatewayRouteTableId,
      });
    }
  }

  /**
   * Function to create TGW static route items
   * @param tgwItem {@link TransitGatewayConfig}
   * @param routeTableItem {@link TransitGatewayRouteTableConfig}
   */
  private createTransitGatewayStaticRouteItems(
    tgwItem: TransitGatewayConfig,
    routeTableItem: TransitGatewayRouteTableConfig,
  ): void {
    // Get TGW route table ID
    const routeTableKey = `${tgwItem.name}_${routeTableItem.name}`;
    const transitGatewayRouteTableId = this.transitGatewayRouteTables.get(routeTableKey);
    if (!transitGatewayRouteTableId) {
      this.logger.error(`Transit Gateway route table ${routeTableKey} not found`);
      throw new Error(`Configuration validation failed at runtime.`);
    }

    for (const routeItem of routeTableItem.routes ?? []) {
      this.createTransitGatewayStaticRouteItem(tgwItem, routeTableItem, routeItem, transitGatewayRouteTableId);
    }
  }

  /**
   * Create transit gateway static routes, blackhole routes,
   * and prefix list references for VPC and DX Gateway attachments
   * @param props
   */
  private createTransitGatewayStaticRoutes(props: AcceleratorStackProps) {
    for (const tgwItem of props.networkConfig.transitGateways ?? []) {
      const accountId = this.props.accountsConfig.getAccountId(tgwItem.account);
      if (this.isTargetStack([accountId], [tgwItem.region])) {
        for (const routeTableItem of tgwItem.routeTables ?? []) {
          this.createTransitGatewayStaticRouteItems(tgwItem, routeTableItem);
        }
      }
    }
  }

  /**
   * Function to get static route attachment configuration
   * @param routeItem {@link TransitGatewayRouteEntryConfig}
   * @param routeTableItem {@link TransitGatewayRouteTableConfig}
   * @param tgwItem {@link TransitGatewayConfig}
   * @returns
   */
  private getStaticRouteAttachmentConfig(
    routeItem: TransitGatewayRouteEntryConfig,
    routeTableItem: TransitGatewayRouteTableConfig,
    tgwItem: TransitGatewayConfig,
  ): {
    routeId: string;
    transitGatewayAttachmentId?: string;
  } {
    let routeId = '';
    let transitGatewayAttachmentId: string | undefined;
    if (routeItem.attachment) {
      // If route is for VPC attachment
      if (
        isNetworkType<TransitGatewayRouteTableVpcEntryConfig>(
          'ITransitGatewayRouteTableVpcEntryConfig',
          routeItem.attachment,
        )
      ) {
        this.logger.info(
          `Adding route ${routeItem.destinationCidrBlock} to TGW route table ${routeTableItem.name} for TGW ${tgwItem.name} in account: ${tgwItem.account}`,
        );
        routeId = `${routeTableItem.name}-${routeItem.destinationCidrBlock}-${routeItem.attachment.vpcName}-${routeItem.attachment.account}`;
        transitGatewayAttachmentId = this.transitGatewayAttachments.get(
          `${tgwItem.name}_${routeItem.attachment.account}_${routeItem.attachment.vpcName}`,
        );
      }

      // If route is for DX Gateway attachment
      if (
        isNetworkType<TransitGatewayRouteTableDxGatewayEntryConfig>(
          'ITransitGatewayRouteTableDxGatewayEntryConfig',
          routeItem.attachment,
        )
      ) {
        this.logger.info(
          `Adding route ${routeItem.destinationCidrBlock} to TGW route table ${routeTableItem.name} for TGW ${tgwItem.name} in account: ${tgwItem.account}`,
        );
        routeId = `${routeTableItem.name}-${routeItem.destinationCidrBlock}-${routeItem.attachment.directConnectGatewayName}`;

        // Get TGW attachment ID
        transitGatewayAttachmentId = this.transitGatewayAttachments.get(
          `${routeItem.attachment.directConnectGatewayName}_${tgwItem.name}`,
        );
      }

      // If route is for VPN attachment
      if (
        isNetworkType<TransitGatewayRouteTableVpnEntryConfig>(
          'ITransitGatewayRouteTableVpnEntryConfig',
          routeItem.attachment,
        )
      ) {
        this.logger.info(
          `Adding route ${routeItem.destinationCidrBlock} to TGW route table ${routeTableItem.name} for TGW ${tgwItem.name} in account: ${tgwItem.account}`,
        );
        routeId = `${routeTableItem.name}-${routeItem.destinationCidrBlock}-${routeItem.attachment.vpnConnectionName}`;

        // Get TGW attachment ID
        transitGatewayAttachmentId = this.transitGatewayAttachments.get(
          `${routeItem.attachment.vpnConnectionName}_${tgwItem.name}`,
        );
      }

      // If route is for TGW peering attachment
      if (
        isNetworkType<TransitGatewayRouteTableTgwPeeringEntryConfig>(
          'ITransitGatewayRouteTableTgwPeeringEntryConfig',
          routeItem.attachment,
        )
      ) {
        this.logger.info(
          `Adding route ${routeItem.destinationCidrBlock} to TGW route table ${routeTableItem.name} for TGW ${tgwItem.name} in account: ${tgwItem.account}`,
        );
        routeId = `${routeTableItem.name}-${routeItem.destinationCidrBlock}-${routeItem.attachment.transitGatewayPeeringName}`;

        // Get TGW attachment ID
        transitGatewayAttachmentId = this.getTgwPeeringAttachmentId(
          routeItem.attachment.transitGatewayPeeringName,
          tgwItem,
        );
      }
    }

    if (routeItem.attachment && !transitGatewayAttachmentId) {
      this.logger.error(`Unable to locate transit gateway attachment ID for route table item ${routeTableItem.name}`);
      throw new Error(`Configuration validation failed at runtime.`);
    }
    return { routeId: routeId, transitGatewayAttachmentId: transitGatewayAttachmentId };
  }

  /**
   * Function to get prefix list reference configuration
   * @param routeItem {@link TransitGatewayRouteEntryConfig}
   * @param routeTableItem {@link TransitGatewayRouteTableConfig}
   * @param tgwItem {@link TransitGatewayConfig}
   * @returns
   */
  private getPrefixListReferenceConfig(
    routeItem: TransitGatewayRouteEntryConfig,
    routeTableItem: TransitGatewayRouteTableConfig,
    tgwItem: TransitGatewayConfig,
  ): {
    plRouteId: string;
    transitGatewayAttachmentId?: string;
  } {
    let plRouteId = '';
    let transitGatewayAttachmentId: string | undefined = undefined;
    if (routeItem.blackhole) {
      this.logger.info(
        `Adding blackhole prefix list reference ${routeItem.destinationPrefixList} to TGW route table ${routeTableItem.name} for TGW ${tgwItem.name} in account: ${tgwItem.account}`,
      );
      plRouteId = pascalCase(`${routeTableItem.name}${routeItem.destinationPrefixList}Blackhole`);
    }

    if (routeItem.attachment) {
      // If route is for VPC attachment
      if (
        isNetworkType<TransitGatewayRouteTableVpcEntryConfig>(
          'ITransitGatewayRouteTableVpcEntryConfig',
          routeItem.attachment,
        )
      ) {
        this.logger.info(
          `Adding prefix list reference ${routeItem.destinationPrefixList} to TGW route table ${routeTableItem.name} for TGW ${tgwItem.name} in account: ${tgwItem.account}`,
        );
        plRouteId = pascalCase(
          `${routeTableItem.name}${routeItem.destinationPrefixList}${routeItem.attachment.vpcName}${routeItem.attachment.account}`,
        );

        // Get TGW attachment ID
        transitGatewayAttachmentId = this.transitGatewayAttachments.get(
          `${tgwItem.name}_${routeItem.attachment.account}_${routeItem.attachment.vpcName}`,
        );
      }

      // If route is for DX Gateway attachment
      if (
        isNetworkType<TransitGatewayRouteTableDxGatewayEntryConfig>(
          'ITransitGatewayRouteTableDxGatewayEntryConfig',
          routeItem.attachment,
        )
      ) {
        this.logger.info(
          `Adding prefix list reference ${routeItem.destinationPrefixList} to TGW route table ${routeTableItem.name} for TGW ${tgwItem.name} in account: ${tgwItem.account}`,
        );
        plRouteId = pascalCase(
          `${routeTableItem.name}${routeItem.destinationPrefixList}${routeItem.attachment.directConnectGatewayName}`,
        );

        // Get TGW attachment ID
        transitGatewayAttachmentId = this.transitGatewayAttachments.get(
          `${routeItem.attachment.directConnectGatewayName}_${tgwItem.name}`,
        );
      }

      // If route is for VPN attachment
      if (
        isNetworkType<TransitGatewayRouteTableVpnEntryConfig>(
          'ITransitGatewayRouteTableVpnEntryConfig',
          routeItem.attachment,
        )
      ) {
        this.logger.info(
          `Adding prefix list reference ${routeItem.destinationPrefixList} to TGW route table ${routeTableItem.name} for TGW ${tgwItem.name} in account: ${tgwItem.account}`,
        );
        plRouteId = pascalCase(
          `${routeTableItem.name}${routeItem.destinationPrefixList}${routeItem.attachment.vpnConnectionName}`,
        );

        // Get TGW attachment ID
        transitGatewayAttachmentId = this.transitGatewayAttachments.get(
          `${routeItem.attachment.vpnConnectionName}_${tgwItem.name}`,
        );
      }

      // If route is for TGW peering attachment
      if (
        isNetworkType<TransitGatewayRouteTableTgwPeeringEntryConfig>(
          'ITransitGatewayRouteTableTgwPeeringEntryConfig',
          routeItem.attachment,
        )
      ) {
        this.logger.info(
          `Adding prefix list reference ${routeItem.destinationPrefixList} to TGW route table ${routeTableItem.name} for TGW ${tgwItem.name} in account: ${tgwItem.account}`,
        );
        plRouteId = pascalCase(
          `${routeTableItem.name}${routeItem.destinationPrefixList}${routeItem.attachment.transitGatewayPeeringName}`,
        );

        // Get TGW attachment ID
        transitGatewayAttachmentId = this.getTgwPeeringAttachmentId(
          routeItem.attachment.transitGatewayPeeringName,
          tgwItem,
        );
      }
    }

    if (routeItem.attachment && !transitGatewayAttachmentId) {
      this.logger.error(`Unable to locate transit gateway attachment ID for route table item ${routeTableItem.name}`);
      throw new Error(`Configuration validation failed at runtime.`);
    }
    return { plRouteId: plRouteId, transitGatewayAttachmentId: transitGatewayAttachmentId };
  }

  /**
   * Create transit gateway static routes, blackhole routes, and prefix list references
   * @param tgwItem
   * @param routeTableItem
   * @param routeItem
   * @param transitGatewayRouteTableId
   */
  private createTransitGatewayStaticRouteItem(
    tgwItem: TransitGatewayConfig,
    routeTableItem: TransitGatewayRouteTableConfig,
    routeItem: TransitGatewayRouteEntryConfig,
    transitGatewayRouteTableId: string,
  ): void {
    //
    // Create static routes
    //
    if (
      routeItem.destinationCidrBlock &&
      !isEc2FirewallVpnRoute(this.props.networkConfig.customerGateways ?? [], routeItem)
    ) {
      const attachmentConfig = this.getStaticRouteAttachmentConfig(routeItem, routeTableItem, tgwItem);
      let routeId = attachmentConfig.routeId;
      const transitGatewayAttachmentId = attachmentConfig.transitGatewayAttachmentId;
      if (routeItem.blackhole) {
        this.logger.info(
          `Adding blackhole route ${routeItem.destinationCidrBlock} to TGW route table ${routeTableItem.name} for TGW ${tgwItem.name} in account: ${tgwItem.account}`,
        );
        routeId = `${routeTableItem.name}-${routeItem.destinationCidrBlock}-blackhole`;
      }

      if (this.isManagedByAsea(AseaResourceType.TRANSIT_GATEWAY_ROUTE, routeId)) {
        return;
      }

      // Create static route
      new TransitGatewayStaticRoute(this, routeId, {
        transitGatewayRouteTableId,
        blackhole: routeItem.blackhole,
        destinationCidrBlock: routeItem.destinationCidrBlock,
        transitGatewayAttachmentId,
      });
    }

    //
    // Create prefix list references
    //
    if (
      routeItem.destinationPrefixList &&
      !isEc2FirewallVpnRoute(this.props.networkConfig.customerGateways ?? [], routeItem)
    ) {
      // Get PL ID from map
      const prefixListId = this.prefixListMap.get(routeItem.destinationPrefixList);
      if (!prefixListId) {
        this.logger.error(`Prefix list ${routeItem.destinationPrefixList} not found`);
        throw new Error(`Configuration validation failed at runtime.`);
      }

      const prefixListReferenceConfig = this.getPrefixListReferenceConfig(routeItem, routeTableItem, tgwItem);

      const plRouteId = prefixListReferenceConfig.plRouteId;
      const transitGatewayAttachmentId = prefixListReferenceConfig.transitGatewayAttachmentId;

      if (this.isManagedByAsea(AseaResourceType.TRANSIT_GATEWAY_ROUTE, plRouteId)) {
        return;
      }

      // Create prefix list reference
      new TransitGatewayPrefixListReference(this, plRouteId, {
        prefixListId,
        blackhole: routeItem.blackhole,
        transitGatewayAttachmentId,
        transitGatewayRouteTableId,
        logGroupKmsKey: this.cloudwatchKey,
        logRetentionInDays: this.logRetention,
      });
    }
  }

  /**
   * Function to get transit gateway peering attachment ID
   * @param transitGatewayPeeringName
   * @param tgwItem
   * @returns
   */
  private getTgwPeeringAttachmentId(transitGatewayPeeringName: string, tgwItem: TransitGatewayConfig): string {
    const requesterConfig = this.props.networkConfig.getTgwPeeringRequesterAccepterConfig(
      transitGatewayPeeringName,
      'requester',
    );
    const accepterConfig = this.props.networkConfig.getTgwPeeringRequesterAccepterConfig(
      transitGatewayPeeringName,
      'accepter',
    );

    if (!requesterConfig || !accepterConfig) {
      this.logger.error(`Transit gateway peering ${transitGatewayPeeringName} not found !!!`);
      throw new Error(`Configuration validation failed at runtime.`);
    }

    // Get TGW attachment ID for requester
    if (this.props.accountsConfig.getAccountId(requesterConfig.account) === cdk.Stack.of(this).account) {
      return cdk.aws_ssm.StringParameter.valueForStringParameter(
        this,
        this.getSsmPath(SsmResourceType.TGW_PEERING, [tgwItem.name, transitGatewayPeeringName]),
      );
    }

    // Get TGW attachment ID for accepter
    if (this.props.accountsConfig.getAccountId(accepterConfig.account) === cdk.Stack.of(this).account) {
      const transitGatewayId = this.transitGateways.get(accepterConfig.transitGatewayName);
      if (!transitGatewayId) {
        this.logger.error(`Transit Gateway ${accepterConfig.transitGatewayName} not found`);
        throw new Error(`Configuration validation failed at runtime.`);
      }

      this.logger.info(
        `Looking up transit gateway peering attachment id of accepter account ${accepterConfig.account}`,
      );
      return TransitGatewayAttachment.fromLookup(
        this,
        pascalCase(`${accepterConfig.account}${transitGatewayPeeringName}TransitGatewayPeeringAttachment`),
        {
          name: transitGatewayPeeringName,
          owningAccountId: cdk.Stack.of(this).account,
          transitGatewayId,
          type: TransitGatewayAttachmentType.PEERING,
          kmsKey: this.cloudwatchKey,
          logRetentionInDays: this.logRetention,
        },
      ).transitGatewayAttachmentId;
    }

    this.logger.error(`Transit Gateway attachment id not found for ${transitGatewayPeeringName}`);
    throw new Error(`Configuration validation failed at runtime.`);
  }
  /**
   * Check if resource is shared with stack.
   *
   * @param shareTargets
   */
  public checkResourceShare(shareTargets: ShareTargets): boolean {
    let included = false;
    included = this.isOrganizationalUnitIncluded(shareTargets.organizationalUnits);

    if (included) {
      return included;
    }

    included = this.isAccountIncluded(shareTargets.accounts);

    return included;
  }

  /**
   * Function to create outbound nacl entry
   * @param vpcItem {@link VpcConfig} | {@link VpcTemplatesConfig}
   * @param naclItem {@link NetworkAclConfig}
   * @param nacl {@link cdk.aws_ec2.INetworkAcl}
   */
  private createOutboundNaclEntry(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    naclItem: NetworkAclConfig,
    nacl: cdk.aws_ec2.INetworkAcl,
  ): void {
    for (const outboundRuleItem of naclItem.outboundRules ?? []) {
      if (this.isIpamCrossAccountNaclSource(outboundRuleItem.destination)) {
        this.logger.info(`Checking outbound rule ${outboundRuleItem.rule} to ${naclItem.name}`);
        const outboundAclTargetProps = this.getIpamSubnetCidr(
          vpcItem.name,
          naclItem,
          outboundRuleItem.destination as NetworkAclSubnetSelection,
          outboundRuleItem,
          'Egress',
        );
        const ruleAction = outboundRuleItem.action === 'allow' ? cdk.aws_ec2.Action.ALLOW : cdk.aws_ec2.Action.DENY;
        new cdk.aws_ec2.CfnNetworkAclEntry(
          this,
          `${vpcItem.name}-${naclItem.name}-outbound-${naclItem.outboundRules?.indexOf(outboundRuleItem)}`,
          {
            protocol: outboundRuleItem.protocol,
            networkAclId: nacl.networkAclId,
            ruleAction: ruleAction,
            ruleNumber: outboundRuleItem.rule,
            cidrBlock: outboundAclTargetProps.ipv4CidrBlock,
            egress: true,
            portRange: {
              from: outboundRuleItem.fromPort,
              to: outboundRuleItem.toPort,
            },
          },
        );
        this.nagSuppressionInputs.push({
          id: NagSuppressionRuleIds.VPC3,
          details: [
            {
              path: `${this.stackName}/${pascalCase(vpcItem.name)}Vpc${pascalCase(naclItem.name)}Nacl/${pascalCase(
                vpcItem.name,
              )}Vpc${pascalCase(naclItem.name)}-Outbound-${outboundRuleItem.rule}`,
              reason: 'NACL added to VPC',
            },
          ],
        });
      }
    }
  }

  /**
   * Function to create inbound nacl entry
   * @param vpcItem {@link VpcConfig} | {@link VpcTemplatesConfig}
   * @param naclItem {@link NetworkAclConfig}
   * @param nacl {@link cdk.aws_ec2.INetworkAcl}
   */
  private createInboundNaclEntry(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    naclItem: NetworkAclConfig,
    nacl: cdk.aws_ec2.INetworkAcl,
  ): void {
    for (const inboundRuleItem of naclItem.inboundRules ?? []) {
      if (this.isIpamCrossAccountNaclSource(inboundRuleItem.source)) {
        this.logger.info(`Checking inbound rule ${inboundRuleItem.rule} to ${naclItem.name}`);
        const inboundAclTargetProps = this.getIpamSubnetCidr(
          vpcItem.name,
          naclItem,
          inboundRuleItem.source as NetworkAclSubnetSelection,
          inboundRuleItem,
          'Ingress',
        );
        const ruleAction = inboundRuleItem.action === 'allow' ? cdk.aws_ec2.Action.ALLOW : cdk.aws_ec2.Action.DENY;
        new cdk.aws_ec2.CfnNetworkAclEntry(
          this,
          `${vpcItem.name}-${naclItem.name}-inbound-${naclItem.inboundRules?.indexOf(inboundRuleItem)}`,
          {
            protocol: inboundRuleItem.protocol,
            networkAclId: nacl.networkAclId,
            ruleAction: ruleAction,
            ruleNumber: inboundRuleItem.rule,
            cidrBlock: inboundAclTargetProps.ipv4CidrBlock,
            egress: false,
            portRange: {
              from: inboundRuleItem.fromPort,
              to: inboundRuleItem.toPort,
            },
          },
        );

        this.nagSuppressionInputs.push({
          id: NagSuppressionRuleIds.VPC3,
          details: [
            {
              path: `${this.stackName}/${pascalCase(vpcItem.name)}Vpc${pascalCase(naclItem.name)}Nacl/${pascalCase(
                vpcItem.name,
              )}Vpc${pascalCase(naclItem.name)}-Inbound-${inboundRuleItem.rule}`,
              reason: 'NACL added to VPC',
            },
          ],
        });
      }
    }
  }

  /**
   * Function to retrieve cross-account NACLs
   * @returns
   */
  private createCrossAccountNaclRules() {
    for (const vpcItem of this.vpcResources) {
      const vpcAccountIds = this.getVpcAccountIds(vpcItem);
      if (this.isTargetStack(vpcAccountIds, [vpcItem.region])) {
        for (const naclItem of vpcItem.networkAcls ?? []) {
          const naclId = cdk.aws_ssm.StringParameter.valueForStringParameter(
            this,
            this.getSsmPath(SsmResourceType.NACL, [vpcItem.name, naclItem.name]),
          );
          const nacl = cdk.aws_ec2.NetworkAcl.fromNetworkAclId(this, `${naclItem.name}-${vpcItem.name}`, naclId);

          // Create inbound nacl entry
          this.createInboundNaclEntry(vpcItem, naclItem, nacl);

          // Create outbound nacl entry
          this.createOutboundNaclEntry(vpcItem, naclItem, nacl);
        }
      }
    }
  }

  /**
   * Retrieve IPAM Subnet CIDR
   * @param vpcName
   * @param naclItem
   * @param target
   */
  private getIpamSubnetCidr(
    vpcName: string,
    naclItem: NetworkAclConfig,
    target: NetworkAclSubnetSelection,
    naclRule: NetworkAclInboundRuleConfig | NetworkAclOutboundRuleConfig,
    trafficType: string,
  ) {
    this.logger.info(
      `Retrieve IPAM Subnet CIDR for account:${target.account} vpc:${target.vpc} subnet:[${target.subnet}] in region:[${target.region}]`,
    );
    const accountId = this.props.accountsConfig.getAccountId(target.account);
    return IpamSubnet.fromLookup(
      this,
      pascalCase(`${vpcName}-${naclItem.name}${naclRule.rule}${trafficType}NaclRule`),
      {
        owningAccountId: accountId,
        ssmSubnetIdPath: this.getSsmPath(SsmResourceType.SUBNET, [target.vpc, target.subnet]),
        region: target.region ?? cdk.Stack.of(this).region,
        roleName: this.acceleratorResourceNames.roles.ipamSubnetLookup,
        kmsKey: this.cloudwatchKey,
        logRetentionInDays: this.logRetention,
      },
    );
  }

  /**
   * Function to create share subnet tags
   * @param vpc {@link VpcConfig}
   * @param subnet {@link SubnetConfig}
   * @param owningAccountId string
   *
   * @remarks
   * Only get the shared subnets that have tags configured
   */
  private createShareSubnetTags(vpc: VpcConfig, subnet: SubnetConfig, owningAccountId: string): void {
    if (subnet.shareTargets) {
      const shared = this.checkResourceShare(subnet.shareTargets);
      if (shared) {
        const sharedSubnet = this.getResourceShare(
          `${subnet.name}_SubnetShare`,
          'ec2:Subnet',
          owningAccountId,
          this.cloudwatchKey,
          vpc.name,
        );
        const vpcTags = this.setVpcTags(vpc);
        const subnetTags = this.setSubnetTags(subnet);
        const sharedSubnetId = sharedSubnet.resourceShareItemId;
        this.logger.info('Applying subnet and vpc tags for RAM shared resources');
        new ShareSubnetTags(this, `ShareSubnetTags${vpc.account}-${subnet.name}`, {
          vpcTags,
          subnetTags,
          sharedSubnetId,
          owningAccountId,
          vpcName: vpc.name,
          subnetName: subnet.name,
          resourceLoggingKmsKey: this.cloudwatchKey,
          logRetentionInDays: this.logRetention,
          acceleratorSsmParamPrefix: this.props.prefixes.ssmParamName,
        });
      }
    }
  }

  private setVpcTags(vpc: VpcConfig) {
    const vpcTags: Tag[] = [];
    if (vpc.tags) {
      vpcTags.push(...vpc.tags);
    }
    const vpcNameTagExists = vpcTags.find(tag => tag.key === 'Name');
    if (!vpcNameTagExists) {
      vpcTags.push({ key: 'Name', value: vpc.name });
    }
    return vpcTags;
  }

  private setSubnetTags(subnet: SubnetConfig) {
    const subnetTags: Tag[] = [];
    if (subnet.tags) {
      subnetTags.push(...subnet.tags);
    }
    const subnetNameExists = subnetTags.find(tag => tag.key === 'Name');

    if (!subnetNameExists) {
      subnetTags.push({ key: 'Name', value: subnet.name });
    }

    return subnetTags;
  }
  private shareSubnetTags() {
    for (const vpc of this.props.networkConfig.vpcs) {
      const owningAccountId = this.props.accountsConfig.getAccountId(vpc.account);
      if (owningAccountId !== cdk.Stack.of(this).account && vpc.region === cdk.Stack.of(this).region) {
        for (const subnet of vpc.subnets ?? []) {
          this.createShareSubnetTags(vpc, subnet, owningAccountId);
        }
      }
    }
  }

  /**
   * Function to share active directory
   * @param managedActiveDirectory {@link ManagedActiveDirectoryConfig}
   * @param activeDirectory {@link ActiveDirectory}
   * @returns string[]
   *
   * @remarks
   * Returns list of account names MAD shared with.
   */
  private shareActiveDirectory(
    managedActiveDirectory: ManagedActiveDirectoryConfig,
    activeDirectory: ActiveDirectory,
  ): string[] {
    const sharedAccountNames = this.props.iamConfig.getManageActiveDirectorySharedAccountNames(
      managedActiveDirectory.name,
      this.props.configDirPath,
    );

    const sharedAccountIds: string[] = [];
    for (const account of sharedAccountNames) {
      sharedAccountIds.push(this.props.accountsConfig.getAccountId(account));
    }
    if (sharedAccountIds.length > 0) {
      this.logger.info(`Sharing Managed active directory ${managedActiveDirectory.name}`);
      const shareActiveDirectory = new ShareActiveDirectory(
        this,
        `${pascalCase(managedActiveDirectory.name)}ShareDirectory`,
        {
          directoryId: activeDirectory.id,
          sharedTargetAccountIds: sharedAccountIds,
          accountAccessRoleName: this.acceleratorResourceNames.roles.madShareAccept,
          lambdaKey: this.lambdaKey,
          cloudwatchKey: this.cloudwatchKey,
          cloudwatchLogRetentionInDays: this.props.globalConfig.cloudwatchLogRetentionInDays,
        },
      );

      shareActiveDirectory.node.addDependency(activeDirectory);

      // AwsSolutions-IAM5: The IAM entity contains wildcard permissions
      this.nagSuppressionInputs.push({
        id: NagSuppressionRuleIds.IAM5,
        details: [
          {
            path: `${this.stackName}/${pascalCase(
              managedActiveDirectory.name,
            )}ShareDirectory/ShareManageActiveDirectoryFunction/ServiceRole/DefaultPolicy/Resource`,
            reason: 'Custom resource lambda needs to access to directory service.',
          },
        ],
      });

      // AwsSolutions-IAM4: The IAM user, role, or group uses AWS managed policies
      this.nagSuppressionInputs.push({
        id: NagSuppressionRuleIds.IAM4,
        details: [
          {
            path: `${this.stackName}/${pascalCase(
              managedActiveDirectory.name,
            )}ShareDirectory/ShareManageActiveDirectoryFunction/ServiceRole/Resource`,
            reason: 'Custom resource lambda needs to access to directory service.',
          },
        ],
      });

      // AwsSolutions-IAM4: The IAM user, role, or group uses AWS managed policies
      this.nagSuppressionInputs.push({
        id: NagSuppressionRuleIds.IAM4,
        details: [
          {
            path: `${this.stackName}/${pascalCase(
              managedActiveDirectory.name,
            )}ShareDirectory/ShareManageActiveDirectoryProvider/framework-onEvent/ServiceRole/Resource`,
            reason: 'Custom resource lambda needs to access to directory service.',
          },
        ],
      });

      // AwsSolutions-IAM5: The IAM entity contains wildcard permissions
      this.nagSuppressionInputs.push({
        id: NagSuppressionRuleIds.IAM5,
        details: [
          {
            path: `${this.stackName}/${pascalCase(
              managedActiveDirectory.name,
            )}ShareDirectory/ShareManageActiveDirectoryProvider/framework-onEvent/ServiceRole/DefaultPolicy/Resource`,
            reason: 'Custom resource lambda needs to access to directory service.',
          },
        ],
      });
    }

    return sharedAccountNames;
  }

  private getMadInstanceSubnetConfig(
    managedActiveDirectory: ManagedActiveDirectoryConfig,
    madVpcLookup: VpcIdLookup,
  ): { madSubnetIds: string[]; madInstanceSubnetId: string } {
    const madSubnetIds: string[] = [];
    let madInstanceSubnetId: string | undefined;
    for (const madSubnet of managedActiveDirectory.vpcSettings.subnets ?? []) {
      const madSubnetLookup = new SubnetIdLookup(
        this,
        `${pascalCase(managedActiveDirectory.name)}${pascalCase(madSubnet)}SubnetLookup`,
        {
          subnetName: madSubnet,
          vpcId: madVpcLookup.vpcId,
          lambdaKey: this.lambdaKey,
          cloudwatchKey: this.cloudwatchKey,
          cloudwatchLogRetentionInDays: this.props.globalConfig.cloudwatchLogRetentionInDays,
        },
      );

      // AwsSolutions-IAM4: The IAM user, role, or group uses AWS managed policies
      this.nagSuppressionInputs.push({
        id: NagSuppressionRuleIds.IAM4,
        details: [
          {
            path: `${this.stackName}/${pascalCase(managedActiveDirectory.name)}${pascalCase(
              madSubnet,
            )}SubnetLookup/SubnetIdLookupFunction/ServiceRole/Resource`,
            reason: 'Custom resource lambda needs this access.',
          },
        ],
      });

      // AwsSolutions-IAM4: The IAM user, role, or group uses AWS managed policies
      this.nagSuppressionInputs.push({
        id: NagSuppressionRuleIds.IAM4,
        details: [
          {
            path: `${this.stackName}/${pascalCase(managedActiveDirectory.name)}${pascalCase(
              madSubnet,
            )}SubnetLookup/SubnetIdLookupProvider/framework-onEvent/ServiceRole/Resource`,
            reason: 'Custom resource lambda needs this access.',
          },
        ],
      });

      // AwsSolutions-IAM5: The IAM entity contains wildcard permissions
      this.nagSuppressionInputs.push({
        id: NagSuppressionRuleIds.IAM5,
        details: [
          {
            path: `${this.stackName}/${pascalCase(managedActiveDirectory.name)}${pascalCase(
              madSubnet,
            )}SubnetLookup/SubnetIdLookupProvider/framework-onEvent/ServiceRole/DefaultPolicy/Resource`,
            reason: 'Custom resource lambda needs this access.',
          },
        ],
      });

      // AwsSolutions-IAM5: The IAM entity contains wildcard permissions
      this.nagSuppressionInputs.push({
        id: NagSuppressionRuleIds.IAM5,
        details: [
          {
            path: `${this.stackName}/${pascalCase(managedActiveDirectory.name)}${pascalCase(
              madSubnet,
            )}SubnetLookup/SubnetIdLookupFunction/ServiceRole/DefaultPolicy/Resource`,
            reason: 'Custom resource lambda needs this access.',
          },
        ],
      });

      madSubnetIds.push(madSubnetLookup.subnetId);

      if (
        managedActiveDirectory.activeDirectoryConfigurationInstance &&
        madSubnet === managedActiveDirectory.activeDirectoryConfigurationInstance.subnetName
      ) {
        madInstanceSubnetId = madSubnetLookup.subnetId;
      }
    }

    return { madInstanceSubnetId: madInstanceSubnetId!, madSubnetIds: madSubnetIds };
  }

  /**
   * Create Managed active directories
   */
  private createManagedActiveDirectories() {
    for (const managedActiveDirectory of this.props.iamConfig.managedActiveDirectories ?? []) {
      if (this.isManagedByAsea(AseaResourceType.MANAGED_AD, managedActiveDirectory.name)) {
        this.logger.info(`${managedActiveDirectory.name} is managed by ASEA, skipping creation of resources.`);
        return;
      }
      const madAccountId = this.props.accountsConfig.getAccountId(managedActiveDirectory.account);

      if (this.isTargetStack([madAccountId], [managedActiveDirectory.region])) {
        this.logger.info(`Creating Managed active directory ${managedActiveDirectory.name}`);

        const madVpcLookup = new VpcIdLookup(this, `${pascalCase(managedActiveDirectory.name)}VpcLookup`, {
          vpcName: managedActiveDirectory.vpcSettings.vpcName,
          lambdaKey: this.lambdaKey,
          cloudwatchKey: this.cloudwatchKey,
          cloudwatchLogRetentionInDays: this.props.globalConfig.cloudwatchLogRetentionInDays,
        });

        // AwsSolutions-IAM4: The IAM user, role, or group uses AWS managed policies
        this.nagSuppressionInputs.push({
          id: NagSuppressionRuleIds.IAM4,
          details: [
            {
              path: `${this.stackName}/${pascalCase(
                managedActiveDirectory.name,
              )}VpcLookup/VpcIdLookupFunction/ServiceRole/Resource`,
              reason: 'Custom resource lambda needs this access.',
            },
          ],
        });

        // AwsSolutions-IAM4: The IAM user, role, or group uses AWS managed policies
        this.nagSuppressionInputs.push({
          id: NagSuppressionRuleIds.IAM4,
          details: [
            {
              path: `${this.stackName}/${pascalCase(
                managedActiveDirectory.name,
              )}VpcLookup/VpcIdLookupProvider/framework-onEvent/ServiceRole/Resource`,
              reason: 'Custom resource lambda needs this access.',
            },
          ],
        });

        // AwsSolutions-IAM5: The IAM entity contains wildcard permissions
        this.nagSuppressionInputs.push({
          id: NagSuppressionRuleIds.IAM5,
          details: [
            {
              path: `${this.stackName}/${pascalCase(
                managedActiveDirectory.name,
              )}VpcLookup/VpcIdLookupFunction/ServiceRole/DefaultPolicy/Resource`,
              reason: 'Custom resource lambda needs this access.',
            },
          ],
        });

        // AwsSolutions-IAM5: The IAM entity contains wildcard permissions
        this.nagSuppressionInputs.push({
          id: NagSuppressionRuleIds.IAM5,
          details: [
            {
              path: `${this.stackName}/${pascalCase(
                managedActiveDirectory.name,
              )}VpcLookup/VpcIdLookupProvider/framework-onEvent/ServiceRole/DefaultPolicy/Resource`,
              reason: 'Custom resource lambda needs this access.',
            },
          ],
        });

        const madInstanceSubnetConfig = this.getMadInstanceSubnetConfig(managedActiveDirectory, madVpcLookup);

        let logGroupName = `/aws/directoryservice/${managedActiveDirectory.name}`;

        if (managedActiveDirectory.logs) {
          logGroupName = managedActiveDirectory.logs.groupName;
        }

        const secretName = `${this.props.prefixes.secretName}/ad-user/${
          managedActiveDirectory.name
        }/${this.props.iamConfig.getManageActiveDirectoryAdminSecretName(managedActiveDirectory.name)}`;

        const madAdminSecretAccountId = this.props.accountsConfig.getAccountId(
          this.props.iamConfig.getManageActiveDirectorySecretAccountName(managedActiveDirectory.name),
        );

        const madAdminSecretRegion = this.props.iamConfig.getManageActiveDirectorySecretRegion(
          managedActiveDirectory.name,
        );

        const adminSecretArn = `arn:${
          cdk.Stack.of(this).partition
        }:secretsmanager:${madAdminSecretRegion}:${madAdminSecretAccountId}:secret:${secretName}`;

        const adminSecretValue = cdk.SecretValue.secretsManager(adminSecretArn);

        const activeDirectory = new ActiveDirectory(this, `${pascalCase(managedActiveDirectory.name)}ActiveDirectory`, {
          directoryName: managedActiveDirectory.name,
          dnsName: managedActiveDirectory.dnsName,
          vpcId: madVpcLookup.vpcId,
          madSubnetIds: madInstanceSubnetConfig.madSubnetIds,
          adminSecretValue,
          edition: managedActiveDirectory.edition,
          netBiosDomainName: managedActiveDirectory.netBiosDomainName,
          logGroupName: logGroupName,
          logRetentionInDays:
            managedActiveDirectory.logs?.retentionInDays ?? this.props.globalConfig.cloudwatchLogRetentionInDays,
          lambdaKey: this.lambdaKey,
          cloudwatchKey: this.cloudwatchKey,
          cloudwatchLogRetentionInDays: this.props.globalConfig.cloudwatchLogRetentionInDays,
        });

        // AwsSolutions-IAM4: The IAM user, role, or group uses AWS managed policies
        this.nagSuppressionInputs.push({
          id: NagSuppressionRuleIds.IAM4,
          details: [
            {
              path: `${this.stackName}/${pascalCase(managedActiveDirectory.name)}ActiveDirectory/${pascalCase(
                managedActiveDirectory.name,
              )}LogSubscription/ManageActiveDirectoryLogSubscriptionFunction/ServiceRole/Resource`,
              reason: 'CDK created IAM user, role, or group.',
            },
          ],
        });

        // AwsSolutions-IAM4: The IAM user, role, or group uses AWS managed policies
        this.nagSuppressionInputs.push({
          id: NagSuppressionRuleIds.IAM4,
          details: [
            {
              path: `${this.stackName}/${pascalCase(managedActiveDirectory.name)}ActiveDirectory/${pascalCase(
                managedActiveDirectory.name,
              )}LogSubscription/ManageActiveDirectoryLogSubscriptionProvider/framework-onEvent/ServiceRole/Resource`,
              reason: 'CDK created IAM user, role, or group.',
            },
          ],
        });

        // AwsSolutions-IAM5: The IAM entity contains wildcard permissions
        this.nagSuppressionInputs.push({
          id: NagSuppressionRuleIds.IAM5,
          details: [
            {
              path: `${this.stackName}/${pascalCase(managedActiveDirectory.name)}ActiveDirectory/${pascalCase(
                managedActiveDirectory.name,
              )}LogSubscription/ManageActiveDirectoryLogSubscriptionFunction/ServiceRole/DefaultPolicy/Resource`,
              reason: 'CDK created IAM service role entity.',
            },
          ],
        });

        // AwsSolutions-IAM5: The IAM entity contains wildcard permissions
        this.nagSuppressionInputs.push({
          id: NagSuppressionRuleIds.IAM5,
          details: [
            {
              path: `${this.stackName}/${pascalCase(managedActiveDirectory.name)}ActiveDirectory/${pascalCase(
                managedActiveDirectory.name,
              )}LogSubscription/ManageActiveDirectoryLogSubscriptionProvider/framework-onEvent/ServiceRole/DefaultPolicy/Resource`,
              reason: 'CDK created IAM service role entity.',
            },
          ],
        });

        // Share active directory
        const sharedAccountNames = this.shareActiveDirectory(managedActiveDirectory, activeDirectory);

        // Update resolver group rule with mad dns ips
        this.updateActiveDirectoryResolverGroupRule(
          managedActiveDirectory.name,
          activeDirectory.dnsIpAddresses,
          managedActiveDirectory.resolverRuleName,
        );

        // Configure managed active directory using provisioned EC2 instance user data
        this.configureManagedActiveDirectory({
          managedActiveDirectory,
          activeDirectory,
          adminSecretArn,
          adSecretAccountId: madAdminSecretAccountId,
          adSecretRegion: madAdminSecretRegion,
          sharedAccountNames,
          madInstanceSubnetId: madInstanceSubnetConfig.madInstanceSubnetId,
          vpcId: madVpcLookup.vpcId,
        });
      }
    }
  }

  /**
   * Function to update resolver rule with MAD dns ips
   * @param directoryName
   * @param dnsIpAddresses
   * @param resolverRuleName
   */
  private updateActiveDirectoryResolverGroupRule(
    directoryName: string,
    dnsIpAddresses: string[],
    resolverRuleName?: string,
  ) {
    if (!resolverRuleName) {
      return;
    }

    this.logger.info(`Updating resolver group for directory ${directoryName}`);
    new ActiveDirectoryResolverRule(this, `${pascalCase(directoryName)}ResolverRule`, {
      route53ResolverRuleName: resolverRuleName,
      targetIps: dnsIpAddresses,
      roleName: `${this.props.prefixes.accelerator}-MAD-${resolverRuleName}`,
      lambdaKmsKey: this.lambdaKey,
      cloudWatchLogsKmsKey: this.cloudwatchKey,
      cloudWatchLogRetentionInDays: this.props.globalConfig.cloudwatchLogRetentionInDays,
    });

    // AwsSolutions-IAM4: The IAM user, role, or group uses AWS managed policies
    this.nagSuppressionInputs.push({
      id: NagSuppressionRuleIds.IAM4,
      details: [
        {
          path: `${this.stackName}/${pascalCase(
            directoryName,
          )}ResolverRule/UpdateResolverRuleFunction/ServiceRole/Resource`,
          reason: 'CDK created IAM user, role, or group.',
        },
      ],
    });

    // AwsSolutions-IAM4: The IAM user, role, or group uses AWS managed policies
    this.nagSuppressionInputs.push({
      id: NagSuppressionRuleIds.IAM4,
      details: [
        {
          path: `${this.stackName}/${pascalCase(
            directoryName,
          )}ResolverRule/UpdateResolverRuleProvider/framework-onEvent/ServiceRole/Resource`,
          reason: 'CDK created IAM user, role, or group.',
        },
      ],
    });

    // AwsSolutions-IAM5: The IAM entity contains wildcard permissions
    this.nagSuppressionInputs.push({
      id: NagSuppressionRuleIds.IAM5,
      details: [
        {
          path: `${this.stackName}/${pascalCase(
            directoryName,
          )}ResolverRule/UpdateResolverRuleFunction/ServiceRole/DefaultPolicy/Resource`,
          reason: 'CDK created IAM service role entity.',
        },
      ],
    });

    // AwsSolutions-IAM5: The IAM entity contains wildcard permissions
    this.nagSuppressionInputs.push({
      id: NagSuppressionRuleIds.IAM5,
      details: [
        {
          path: `${this.stackName}/${pascalCase(
            directoryName,
          )}ResolverRule/UpdateResolverRuleProvider/framework-onEvent/ServiceRole/DefaultPolicy/Resource`,
          reason: 'CDK created IAM service role entity.',
        },
      ],
    });
  }

  /**
   * Function to configure MAD
   * @param managedActiveDirectory
   */
  private configureManagedActiveDirectory(props: {
    managedActiveDirectory: ManagedActiveDirectoryConfig;
    activeDirectory: ActiveDirectory;
    adminSecretArn: string;
    adSecretAccountId: string;
    adSecretRegion: string;
    sharedAccountNames: string[];
    madInstanceSubnetId: string;
    vpcId: string;
  }) {
    if (props.managedActiveDirectory.activeDirectoryConfigurationInstance) {
      const adInstanceConfig = props.managedActiveDirectory.activeDirectoryConfigurationInstance;
      const inboundRules: cdk.aws_ec2.CfnSecurityGroup.IngressProperty[] = [];

      for (const securityGroupInboundSource of adInstanceConfig.securityGroupInboundSources) {
        inboundRules.push({ ipProtocol: 'tcp', cidrIp: securityGroupInboundSource, fromPort: 3389, toPort: 3389 });
        inboundRules.push({ ipProtocol: 'tcp', cidrIp: securityGroupInboundSource, fromPort: 443, toPort: 443 });
      }

      const securityGroup = new cdk.aws_ec2.CfnSecurityGroup(
        this,
        `${pascalCase(props.managedActiveDirectory.name)}SecurityGroup`,
        {
          groupDescription: `${pascalCase(
            props.managedActiveDirectory.name,
          )} managed active directory instance security group`,
          securityGroupEgress: [{ ipProtocol: '-1', cidrIp: '0.0.0.0/0' }],
          securityGroupIngress: inboundRules,
          groupName: `${props.managedActiveDirectory.name}_mad_instance_sg`,
          vpcId: props.vpcId,
          tags: [
            { key: 'Name', value: `${props.managedActiveDirectory.name}_mad_instance_sg` },
            {
              key: 'Description',
              value: `Security group for ${props.managedActiveDirectory.name} managed active directory instance`,
            },
          ],
        },
      );

      const userDataScripts: UserDataScriptsType[] = [];
      if (adInstanceConfig.userDataScripts.length > 0) {
        for (const userDataScript of adInstanceConfig.userDataScripts) {
          userDataScripts.push({
            name: userDataScript.scriptName,
            path: path.join(this.props.configDirPath, userDataScript.scriptFilePath),
          });
        }
      }

      const secretKey = new KeyLookup(this, 'SecretsKmsKeyLookup', {
        accountId: props.adSecretAccountId,
        keyRegion: props.adSecretRegion,
        roleName: this.acceleratorResourceNames.roles.crossAccountSecretsCmkParameterAccess,
        keyArnParameterName: this.acceleratorResourceNames.parameters.secretsManagerCmkArn,
        logRetentionInDays: this.props.globalConfig.cloudwatchLogRetentionInDays,
        acceleratorPrefix: this.props.prefixes.accelerator,
      }).getKey();

      const activeDirectoryConfiguration = new ActiveDirectoryConfiguration(
        this,
        `${pascalCase(props.managedActiveDirectory.name)}ConfigInstance`,
        {
          instanceType: adInstanceConfig.instanceType,
          imagePath: adInstanceConfig.imagePath,
          managedActiveDirectoryName: props.managedActiveDirectory.name,
          managedActiveDirectorySecretAccountId: props.adSecretAccountId,
          managedActiveDirectorySecretRegion: props.adSecretRegion,
          dnsName: props.managedActiveDirectory.dnsName,
          netBiosDomainName: props.managedActiveDirectory.netBiosDomainName,
          adminPwdSecretArn: props.adminSecretArn,
          secretKeyArn: secretKey.keyArn,
          subnetId: props.madInstanceSubnetId,
          securityGroupId: securityGroup.ref,
          instanceRoleName: adInstanceConfig.instanceRole,
          enableTerminationProtection: adInstanceConfig.enableTerminationProtection ?? false,
          userDataScripts,
          adGroups: adInstanceConfig.adGroups,
          adPerAccountGroups: adInstanceConfig.adPerAccountGroups,
          adConnectorGroup: adInstanceConfig.adConnectorGroup,
          adUsers: adInstanceConfig.adUsers,
          secretPrefix: this.props.prefixes.secretName,
          adPasswordPolicy: adInstanceConfig.adPasswordPolicy,
          accountNames: props.sharedAccountNames,
        },
      );

      activeDirectoryConfiguration.node.addDependency(props.activeDirectory);

      // AwsSolutions-IAM4: The IAM user, role, or group uses AWS managed policies
      this.nagSuppressionInputs.push({
        id: NagSuppressionRuleIds.IAM4,
        details: [
          {
            path:
              `${this.stackName}/` +
              pascalCase(props.managedActiveDirectory.name) +
              'ConfigInstance/' +
              pascalCase(props.managedActiveDirectory.name) +
              'InstanceRole/Resource',
            reason: 'AD config instance needs to access user data bucket and bucket encryption key.',
          },
        ],
      });

      // AwsSolutions-EC28: The EC2 instance/AutoScaling launch configuration does not have detailed monitoring enabled
      this.nagSuppressionInputs.push({
        id: NagSuppressionRuleIds.EC28,
        details: [
          {
            path:
              `${this.stackName}/` +
              pascalCase(props.managedActiveDirectory.name) +
              'ConfigInstance/' +
              pascalCase(props.managedActiveDirectory.name) +
              'InstanceRole/Instance',
            reason: 'AD config instance just used to configure MAD through user data.',
          },
        ],
      });

      // AwsSolutions-EC29: The EC2 instance is not part of an ASG and has Termination Protection disabled
      this.nagSuppressionInputs.push({
        id: NagSuppressionRuleIds.EC29,
        details: [
          {
            path:
              `${this.stackName}/` +
              pascalCase(props.managedActiveDirectory.name) +
              'ConfigInstance/' +
              pascalCase(props.managedActiveDirectory.name) +
              'InstanceRole/Instance',
            reason: 'AD config instance just used to configure MAD through user data.',
          },
        ],
      });

      // AwsSolutions-EC28: The EC2 instance/AutoScaling launch configuration does not have detailed monitoring enabled
      this.nagSuppressionInputs.push({
        id: NagSuppressionRuleIds.EC28,
        details: [
          {
            path:
              `${this.stackName}/` +
              pascalCase(props.managedActiveDirectory.name) +
              'ConfigInstance/' +
              pascalCase(props.managedActiveDirectory.name) +
              'Instance',
            reason: 'AD config instance just used to configure MAD through user data.',
          },
        ],
      });

      // AwsSolutions-EC29: The EC2 instance is not part of an ASG and has Termination Protection disabled.
      this.nagSuppressionInputs.push({
        id: NagSuppressionRuleIds.EC29,
        details: [
          {
            path:
              `${this.stackName}/` +
              pascalCase(props.managedActiveDirectory.name) +
              'ConfigInstance/' +
              pascalCase(props.managedActiveDirectory.name) +
              'Instance',
            reason: 'AD config instance just used to configure MAD through user data.',
          },
        ],
      });

      for (const adUser of adInstanceConfig.adUsers ?? []) {
        // AwsSolutions-SMG4: The secret does not have automatic rotation scheduled
        this.nagSuppressionInputs.push({
          id: NagSuppressionRuleIds.SMG4,
          details: [
            {
              path:
                `${this.stackName}/` +
                pascalCase(props.managedActiveDirectory.name) +
                'ConfigInstance/' +
                pascalCase(adUser.name) +
                'Secret/Resource',
              reason: 'AD user secret.',
            },
          ],
        });
      }
    }
  }

  /**
   * Return Primary CIDR Block of VPC
   * @param vpcName
   * @param naclItem
   * @param target
   */
  private getVpcCidr(vpcItem: VpcConfig | VpcTemplatesConfig, vpcAccountId: string): string {
    if (vpcItem.cidrs && vpcItem.cidrs.length > 0) {
      return vpcItem.cidrs[0];
    }
    this.logger.info(
      `Retrieve VPC CIDR for account:${vpcAccountId} vpc:${vpcItem.name} in region:[${cdk.Stack.of(this).region}]`,
    );
    if (this.account === vpcAccountId) {
      return cdk.aws_ssm.StringParameter.valueForStringParameter(
        this,
        this.getSsmPath(SsmResourceType.VPC_IPV4_CIDR_BLOCK, [vpcItem.name]),
      );
    } else {
      const cidrLookup =
        (this.node.tryFindChild(pascalCase(`SsmParamLookup${vpcItem.name}${vpcAccountId}`)) as SsmParameterLookup) ??
        new SsmParameterLookup(this, pascalCase(`SsmParamLookup${vpcItem.name}${vpcAccountId}`), {
          name: this.getSsmPath(SsmResourceType.VPC_IPV4_CIDR_BLOCK, [vpcItem.name]),
          accountId: vpcAccountId,
          parameterRegion: vpcItem.region,
          roleName: `${this.props.prefixes.accelerator}-VpcPeeringRole-${vpcItem.region}`,
          kmsKey: this.cloudwatchKey,
          logRetentionInDays: this.logRetention,
          acceleratorPrefix: this.props.prefixes.accelerator,
        });
      return cidrLookup.value;
    }
  }
}
