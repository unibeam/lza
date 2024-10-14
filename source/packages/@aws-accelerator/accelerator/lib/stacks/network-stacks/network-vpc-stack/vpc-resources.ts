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

import {
  AseaResourceType,
  CustomerGatewayConfig,
  DefaultVpcsConfig,
  isNetworkType,
  VpcConfig,
  VpcTemplatesConfig,
  VpcPeeringConfig,
} from '@aws-accelerator/config';
import { VpcFlowLogsConfig } from '@aws-accelerator/config/dist/lib/common/types';
import {
  DeleteDefaultSecurityGroupRules,
  DeleteDefaultVpc,
  PutSsmParameter,
  SsmParameterProps,
  Vpc,
  VpnConnection,
} from '@aws-accelerator/constructs';
import { SsmResourceType } from '@aws-accelerator/utils/lib/ssm-parameter-path';
import * as cdk from 'aws-cdk-lib';
import { NagSuppressions } from 'cdk-nag';
import { pascalCase } from 'pascal-case';
import { LogLevel, NetworkStack } from '../network-stack';
import { getVpc, getVpcConfig } from '../utils/getter-utils';
import { isIpv4 } from '../utils/validation-utils';

type Ipv4VpcCidrBlock = { cidrBlock: string } | { ipv4IpamPoolId: string; ipv4NetmaskLength: number };
type Ipv6VpcCidrBlock = {
  amazonProvidedIpv6CidrBlock?: boolean;
  ipv6CidrBlock?: string;
  ipv6IpamPoolId?: string;
  ipv6NetmaskLength?: number;
  ipv6Pool?: string;
};

export class VpcResources {
  public readonly deleteDefaultVpc?: DeleteDefaultVpc;
  public readonly sharedParameterMap: Map<string, SsmParameterProps[]>;
  public readonly vpcMap: Map<string, Vpc>;
  public readonly vpnMap: Map<string, string>;
  public readonly centralEndpointRole?: cdk.aws_iam.Role;

  private stack: NetworkStack;

  constructor(
    networkStack: NetworkStack,
    ipamPoolMap: Map<string, string>,
    dhcpOptionsIds: Map<string, string>,
    vpcResources: (VpcConfig | VpcTemplatesConfig)[],
    acceleratorData: { acceleratorPrefix: string; ssmParamName: string; partition: string; useExistingRoles: boolean },
    configData: {
      defaultVpcsConfig: DefaultVpcsConfig;
      centralEndpointVpc: VpcConfig | undefined;
      vpcFlowLogsConfig: VpcFlowLogsConfig | undefined;
      customerGatewayConfigs: CustomerGatewayConfig[] | undefined;
      vpcPeeringConfigs: VpcPeeringConfig[] | undefined;
      firewalls: { accountId: string; firewallVpc: VpcConfig | VpcTemplatesConfig }[];
    },
  ) {
    this.stack = networkStack;

    // Delete default VPC
    this.deleteDefaultVpc = this.deleteDefaultVpcMethod(configData.defaultVpcsConfig);
    // Create central endpoints role
    this.centralEndpointRole = this.createCentralEndpointRole(
      acceleratorData.partition,
      vpcResources,
      configData.centralEndpointVpc,
      acceleratorData.acceleratorPrefix,
    );
    // Create VPCs

    this.vpcMap = this.createVpcs(
      this.stack.vpcsInScope,
      ipamPoolMap,
      dhcpOptionsIds,
      configData.centralEndpointVpc,
      configData.vpcFlowLogsConfig,
      acceleratorData.useExistingRoles,
      acceleratorData.acceleratorPrefix,
    );
    // Create cross-account route role
    this.createCrossAccountRouteRole(
      configData.vpcPeeringConfigs,
      acceleratorData.acceleratorPrefix,
      acceleratorData.ssmParamName,
      configData.firewalls,
    );
    //
    // Create VPN custom resource handler if needed
    const customResourceHandler = this.stack.advancedVpnTypes.includes('vpc')
      ? this.stack.createVpnOnEventHandler()
      : undefined;
    //
    // Create VPN connections
    this.vpnMap = this.createVpnConnections(this.vpcMap, configData.customerGatewayConfigs, customResourceHandler);
    //
    // Create cross-account/cross-region SSM parameters
    this.sharedParameterMap = this.createSharedParameters(
      this.stack.vpcsInScope,
      this.vpcMap,
      configData.customerGatewayConfigs,
    );
  }

  /**
   * Delete default VPC in the current account+region
   * @param props
   * @returns
   */
  private deleteDefaultVpcMethod(defaultVpc: DefaultVpcsConfig): DeleteDefaultVpc | undefined {
    const accountExcluded = defaultVpc.excludeAccounts && this.stack.isAccountExcluded(defaultVpc.excludeAccounts);
    const regionExcluded = defaultVpc.excludeRegions && this.stack.isRegionExcluded(defaultVpc.excludeRegions);

    if (defaultVpc.delete && !accountExcluded && !regionExcluded) {
      this.stack.addLogs(LogLevel.INFO, 'Add DeleteDefaultVpc');
      return new DeleteDefaultVpc(this.stack, 'DeleteDefaultVpc', {
        kmsKey: this.stack.cloudwatchKey,
        logRetentionInDays: this.stack.logRetention,
      });
    }
    return;
  }

  /**
   * Create a cross-account role to assume if useCentralEndpoints VPC
   * does not reside in the same account as the central endpoints VPC
   * @param props
   * @returns
   */
  private createCentralEndpointRole(
    partition: string,
    vpcResources: (VpcConfig | VpcTemplatesConfig)[],
    centralEndpointVpc: VpcConfig | undefined,
    acceleratorPrefix: string,
  ): cdk.aws_iam.Role | undefined {
    if (this.useCentralEndpoints(vpcResources, partition)) {
      if (!centralEndpointVpc) {
        this.stack.addLogs(LogLevel.ERROR, `useCentralEndpoints set to true, but no central endpoint VPC detected`);
        throw new Error(`Configuration validation failed at runtime.`);
      } else {
        const centralEndpointVpcAccountId = this.stack.getVpcAccountIds(centralEndpointVpc).join();
        if (centralEndpointVpcAccountId !== cdk.Stack.of(this.stack).account) {
          this.stack.addLogs(
            LogLevel.INFO,
            'Central endpoints VPC is in an external account, create a role to enable central endpoints',
          );
          const role = new cdk.aws_iam.Role(this.stack, 'EnableCentralEndpointsRole', {
            roleName: `${acceleratorPrefix}-EnableCentralEndpointsRole-${cdk.Stack.of(this.stack).region}`,
            assumedBy: new cdk.aws_iam.AccountPrincipal(centralEndpointVpcAccountId),
            inlinePolicies: {
              default: new cdk.aws_iam.PolicyDocument({
                statements: [
                  new cdk.aws_iam.PolicyStatement({
                    effect: cdk.aws_iam.Effect.ALLOW,
                    actions: ['ec2:DescribeVpcs', 'route53:AssociateVPCWithHostedZone'],
                    resources: ['*'],
                  }),
                ],
              }),
            },
          });

          // AwsSolutions-IAM5: The IAM entity contains wildcard permissions and does not have a cdk_nag rule suppression with evidence for those permission.
          // rule suppression with evidence for this permission.
          NagSuppressions.addResourceSuppressionsByPath(
            this.stack,
            `${this.stack.stackName}/EnableCentralEndpointsRole/Resource/Resource`,
            [
              {
                id: 'AwsSolutions-IAM5',
                reason: 'EnableCentralEndpointsRole needs access to every describe every VPC in the account ',
              },
            ],
          );
          return role;
        }
      }
    }
    return undefined;
  }

  /**
   * Determine if any VPCs in the current stack context have useCentralEndpoints enabled
   * @param vpcResources
   * @param partition
   */
  private useCentralEndpoints(vpcResources: (VpcConfig | VpcTemplatesConfig)[], partition: string): boolean {
    for (const vpcItem of vpcResources) {
      if (vpcItem.useCentralEndpoints) {
        if (partition !== 'aws' && partition !== 'aws-cn') {
          this.stack.addLogs(
            LogLevel.ERROR,
            'useCentralEndpoints set to true, but AWS Partition is not commercial. Please change it to false.',
          );
          throw new Error(`Configuration validation failed at runtime.`);
        }

        return true;
      }
    }
    return false;
  }

  /**
   * Add necessary permissions to cross-account role if VPC peering is implemented
   * @param props
   */
  private getCrossAccountRoutePolicies(peeringAccountIds: string[], ssmPrefix: string) {
    const policyStatements = [
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ['ec2:CreateRoute', 'ec2:DeleteRoute'],
        resources: [`arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:route-table/*`],
      }),
      new cdk.aws_iam.PolicyStatement({
        effect: cdk.aws_iam.Effect.ALLOW,
        actions: ['ssm:GetParameter'],
        resources: [
          `arn:${cdk.Aws.PARTITION}:ssm:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:parameter${ssmPrefix}/network/*`,
        ],
      }),
    ];

    if (peeringAccountIds.length > 0) {
      policyStatements.push(
        new cdk.aws_iam.PolicyStatement({
          effect: cdk.aws_iam.Effect.ALLOW,
          actions: [
            'ec2:AcceptVpcPeeringConnection',
            'ec2:CreateVpcPeeringConnection',
            'ec2:DeleteVpcPeeringConnection',
          ],
          resources: [
            `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:vpc/*`,
            `arn:${cdk.Aws.PARTITION}:ec2:${cdk.Aws.REGION}:${cdk.Aws.ACCOUNT_ID}:vpc-peering-connection/*`,
          ],
        }),
      );
    }
    return policyStatements;
  }

  /**
   * Create cross-account route role if target ENIs exist in external account(s) or peering connections defined
   * @param props
   */
  private createCrossAccountRouteRole(
    vpcPeeringConfig: VpcPeeringConfig[] | undefined,
    acceleratorPrefix: string,
    ssmParamNamePrefix: string,
    firewallInfo: { accountId: string; firewallVpc: VpcConfig | VpcTemplatesConfig }[],
  ): cdk.aws_iam.Role | undefined {
    const crossAccountEniAccountIds = this.getCrossAccountEniAccountIds(firewallInfo);
    const vpcPeeringAccountIds = this.getVpcPeeringAccountIds(vpcPeeringConfig);
    const policyList = this.getCrossAccountRoutePolicies(vpcPeeringAccountIds, ssmParamNamePrefix);

    //
    // Create cross account route role
    //
    const accountIdSet = [...new Set([...(crossAccountEniAccountIds ?? []), ...(vpcPeeringAccountIds ?? [])])];
    if (accountIdSet.length > 0) {
      this.stack.addLogs(
        LogLevel.INFO,
        `Creating cross-account role for the creation of VPC peering connections and routes targeting ENIs`,
      );

      const principals: cdk.aws_iam.PrincipalBase[] = [];
      for (const accountId of accountIdSet) {
        principals.push(new cdk.aws_iam.AccountPrincipal(accountId));
      }

      const role = new cdk.aws_iam.Role(this.stack, 'VpcPeeringRole', {
        roleName: `${acceleratorPrefix}-VpcPeeringRole-${cdk.Stack.of(this.stack).region}`,
        assumedBy: new cdk.aws_iam.CompositePrincipal(...principals),
        inlinePolicies: {
          default: new cdk.aws_iam.PolicyDocument({
            statements: policyList,
          }),
        },
      });

      // AwsSolutions-IAM5: The IAM entity contains wildcard permissions and does not have a cdk_nag rule suppression with evidence for those permission.
      // rule suppression with evidence for this permission.
      NagSuppressions.addResourceSuppressionsByPath(this.stack, `${this.stack.stackName}/VpcPeeringRole/Resource`, [
        {
          id: 'AwsSolutions-IAM5',
          reason: 'VpcPeeringRole needs access to create routes for VPCs in the account',
        },
      ]);
      return role;
    }
    return undefined;
  }
  /**
   * Return an array of cross-account account IDs for VPCs with firewall VPC endpoints
   * @param props
   * @returns
   */
  private getCrossAccountEniAccountIds(
    firewallInfo: { accountId: string; firewallVpc: VpcConfig | VpcTemplatesConfig }[],
  ) {
    const crossAccountEniAccountIds: string[] = [];

    for (const firewallItem of firewallInfo) {
      if (this.isFirewallOwnedByDifferentAccount(firewallItem)) {
        crossAccountEniAccountIds.push(...firewallItem.accountId);
      }
    }
    // firewalls can be deployed in same account across regions so removing duplicates.
    return [...new Set(crossAccountEniAccountIds)];
  }

  private isFirewallOwnedByDifferentAccount(firewallItem: {
    accountId: string;
    firewallVpc: VpcConfig | VpcTemplatesConfig;
  }) {
    // Check that firewall account is not this account

    // Firewall can be deployed to same account but different region
    // Check that the firewall's target VPC is deployed in this account

    return firewallItem.accountId !== this.stack.account && this.vpcMap.has(firewallItem.firewallVpc.name);
  }

  /**
   * Return an array of VPC peering requester account IDs
   * if an accepter VPC exists in this account+region
   * @param props
   * @returns
   */
  private getVpcPeeringAccountIds(vpcPeering: VpcPeeringConfig[] | undefined): string[] {
    //
    // Loop through VPC peering entries. Determine if accepter VPC is in external account.
    //
    const vpcPeeringAccountIds: string[] = [];
    for (const peering of vpcPeering ?? []) {
      // Get requester and accepter VPC configurations
      const requesterVpc = this.stack.vpcResources.find(item => item.name === peering.vpcs[0])!;
      const accepterVpc = this.stack.vpcResources.find(item => item.name === peering.vpcs[1])!;
      const requesterAccountIds = this.stack.getVpcAccountIds(requesterVpc);
      const accepterAccountIds = this.stack.getVpcAccountIds(accepterVpc);
      let crossAccountCondition = false;

      // Check for different account peering -- only add IAM role to accepter account
      if (this.stack.isTargetStack(accepterAccountIds, [accepterVpc.region])) {
        if (
          isNetworkType<VpcTemplatesConfig>('IVpcTemplatesConfig', requesterVpc) ||
          isNetworkType<VpcTemplatesConfig>('IVpcTemplatesConfig', accepterVpc)
        ) {
          crossAccountCondition =
            // true: If VPCs in peering connection are cross region
            accepterVpc.region !== requesterVpc.region ||
            // true: If requester or accepter has more accounts
            requesterAccountIds.length !== accepterAccountIds.length ||
            // true: If requester has any other accounts apart from accepter
            requesterAccountIds.filter(requesterAccountId => requesterAccountId !== this.stack.account).length > 0;
        } else {
          crossAccountCondition =
            requesterVpc.account !== accepterVpc.account || requesterVpc.region !== accepterVpc.region;
        }
        if (crossAccountCondition) {
          vpcPeeringAccountIds.push(...requesterAccountIds);
        }
        if (requesterVpc.region !== accepterVpc.region) {
          vpcPeeringAccountIds.push(this.stack.account);
        }
      }
    }
    return [...new Set(vpcPeeringAccountIds)];
  }

  /**
   * Create VPCs for this stack context
   * @param vpcResources
   * @param ipamPoolMap
   * @param dhcpOptionsIds
   * @param props
   */
  private createVpcs(
    vpcResources: (VpcConfig | VpcTemplatesConfig)[],
    ipamPoolMap: Map<string, string>,
    dhcpOptionsIds: Map<string, string>,
    centralEndpointVpc: VpcConfig | undefined,
    vpcFlowLogsNetworkConfig: VpcFlowLogsConfig | undefined,
    useExistingRoles: boolean,
    acceleratorPrefix: string,
  ): Map<string, Vpc> {
    const vpcMap = new Map<string, Vpc>();

    for (const vpcItem of vpcResources) {
      const vpc = this.createVpcItem(
        vpcItem,
        dhcpOptionsIds,
        ipamPoolMap,
        centralEndpointVpc,
        vpcFlowLogsNetworkConfig,
        useExistingRoles,
        acceleratorPrefix,
      );
      vpcMap.set(vpcItem.name, vpc);
    }
    return vpcMap;
  }

  /**
   * Create a VPC from a given configuration item
   * @param vpcItem
   * @param dhcpOptionsIds
   * @param ipamPoolMap
   * @param props
   * @returns
   */
  private createVpcItem(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    dhcpOptionsIds: Map<string, string>,
    ipamPoolMap: Map<string, string>,
    centralEndpointVpc: VpcConfig | undefined,
    vpcFlowLogsNetworkConfig: VpcFlowLogsConfig | undefined,
    useExistingRoles: boolean,
    acceleratorPrefix: string,
  ): Vpc {
    this.stack.addLogs(LogLevel.INFO, `Adding VPC ${vpcItem.name}`);
    //
    // Determine if using IPAM or manual CIDRs
    //
    let cidr: string | undefined = undefined;
    let poolId: string | undefined = undefined;
    let poolNetmask: number | undefined = undefined;
    // Get first CIDR in array
    if (vpcItem.cidrs) {
      cidr = vpcItem.cidrs[0];
    }

    // Get IPAM details
    if (vpcItem.ipamAllocations) {
      poolId = ipamPoolMap.get(vpcItem.ipamAllocations[0].ipamPoolName);
      if (!poolId) {
        this.stack.addLogs(
          LogLevel.ERROR,
          `${vpcItem.name}: unable to locate IPAM pool ${vpcItem.ipamAllocations[0].ipamPoolName}`,
        );
        throw new Error(`Configuration validation failed at runtime.`);
      }
      poolNetmask = vpcItem.ipamAllocations[0].netmaskLength;
    }
    // Create or import VPC
    const vpc = this.createOrImportVpc({
      vpcItem,
      dhcpOptionsIds,
      cidr,
      poolId,
      poolNetmask,
    });
    //
    // Create additional IPv4 CIDRs
    //
    this.createAdditionalIpv4Cidrs(vpc, vpcItem, ipamPoolMap);
    //
    // Create IPv6 CIDRs
    //
    this.createIpv6Cidrs(vpc, vpcItem);
    //
    // Add central endpoint tags
    //
    this.addCentralEndpointTags(vpc, vpcItem, centralEndpointVpc);
    //
    // Add flow logs, if configured
    //
    this.getVpcFlowLogConfig(vpc, vpcItem, vpcFlowLogsNetworkConfig, useExistingRoles, acceleratorPrefix);
    //
    // Delete default security group rules
    //
    this.deleteDefaultSgRules(vpc, vpcItem);
    //
    // Add dependency on default VPC deletion
    //
    this.addDefaultVpcDependency(vpc, vpcItem);
    return vpc;
  }

  /**
   * Create or import the configured VPC
   * @param options
   * @returns Vpc
   */
  private createOrImportVpc(options: {
    vpcItem: VpcConfig | VpcTemplatesConfig;
    dhcpOptionsIds: Map<string, string>;
    cidr?: string;
    poolId?: string;
    poolNetmask?: number;
  }): Vpc {
    let vpc: Vpc;

    if (this.stack.isManagedByAsea(AseaResourceType.EC2_VPC, options.vpcItem.name)) {
      //
      // Import VPC
      //
      const vpcId = this.stack.getExternalResourceParameter(
        this.stack.getSsmPath(SsmResourceType.VPC, [options.vpcItem.name]),
      );
      const internetGatewayId = this.stack.getExternalResourceParameter(
        this.stack.getSsmPath(SsmResourceType.IGW, [options.vpcItem.name]),
      );
      const virtualPrivateGatewayId = this.stack.getExternalResourceParameter(
        this.stack.getSsmPath(SsmResourceType.VPN_GW, [options.vpcItem.name]),
      );
      vpc = Vpc.fromVpcAttributes(this.stack, pascalCase(`${options.vpcItem.name}Vpc`), {
        name: options.vpcItem.name,
        vpcId,
        internetGatewayId,
        virtualPrivateGatewayId,
        // ASEA VPC Resources are all cidr specified resources. IPAM is not supported during migration.
        cidrBlock: options.vpcItem.cidrs?.[0] ?? '',
      });
      if (options.vpcItem.internetGateway && !internetGatewayId) {
        vpc.addInternetGateway();
      }
      if (options.vpcItem.virtualPrivateGateway && !virtualPrivateGatewayId) {
        vpc.addVirtualPrivateGateway(options.vpcItem.virtualPrivateGateway.asn);
      }
      if (options.vpcItem.dhcpOptions) {
        vpc.setDhcpOptions(options.vpcItem.dhcpOptions);
      }
    } else {
      //
      // Create VPC
      //
      vpc = new Vpc(this.stack, pascalCase(`${options.vpcItem.name}Vpc`), {
        name: options.vpcItem.name,
        ipv4CidrBlock: options.cidr,
        internetGateway: options.vpcItem.internetGateway,
        dhcpOptions: options.dhcpOptionsIds.get(options.vpcItem.dhcpOptions ?? ''),
        egressOnlyIgw: options.vpcItem.egressOnlyIgw,
        enableDnsHostnames: options.vpcItem.enableDnsHostnames ?? true,
        enableDnsSupport: options.vpcItem.enableDnsSupport ?? true,
        instanceTenancy: options.vpcItem.instanceTenancy ?? 'default',
        ipv4IpamPoolId: options.poolId,
        ipv4NetmaskLength: options.poolNetmask,
        tags: options.vpcItem.tags,
        virtualPrivateGateway: options.vpcItem.virtualPrivateGateway,
      });
      this.stack.addSsmParameter({
        logicalId: pascalCase(`SsmParam${pascalCase(options.vpcItem.name)}VpcId`),
        parameterName: this.stack.getSsmPath(SsmResourceType.VPC, [options.vpcItem.name]),
        stringValue: vpc.vpcId,
      });

      if (vpc.virtualPrivateGatewayId) {
        this.stack.addSsmParameter({
          logicalId: pascalCase(`SsmParam${pascalCase(options.vpcItem.name)}VpnGatewayId`),
          parameterName: this.stack.getSsmPath(SsmResourceType.VPN_GW, [options.vpcItem.name]),
          stringValue: vpc.virtualPrivateGatewayId!,
        });
      }
    }
    return vpc;
  }

  /**
   * Create additional IPv4 CIDR blocks for a given VPC
   * @param vpc
   * @param vpcItem
   * @param ipamPoolMap
   * @returns
   */
  private createAdditionalIpv4Cidrs(
    vpc: Vpc,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    ipamPoolMap: Map<string, string>,
  ): Ipv4VpcCidrBlock[] {
    const additionalCidrs: Ipv4VpcCidrBlock[] = [];

    if (vpcItem.cidrs && vpcItem.cidrs.length > 1) {
      for (const vpcCidr of vpcItem.cidrs.slice(1)) {
        if (this.stack.isManagedByAsea(AseaResourceType.EC2_VPC_CIDR, `${vpcItem.name}-${vpcCidr}`)) {
          // CIDR is created by external source. Skipping creation
          continue;
        }
        this.stack.addLogs(LogLevel.INFO, `Adding secondary CIDR ${vpcCidr} to VPC ${vpcItem.name}`);
        vpc.addIpv4Cidr({ cidrBlock: vpcCidr });
        additionalCidrs.push({ cidrBlock: vpcCidr });
      }
    }

    if (vpcItem.ipamAllocations && vpcItem.ipamAllocations.length > 1) {
      for (const alloc of vpcItem.ipamAllocations.slice(1)) {
        this.stack.addLogs(
          LogLevel.INFO,
          `Adding secondary IPAM allocation with netmask ${alloc.netmaskLength} to VPC ${vpcItem.name}`,
        );
        const poolId = ipamPoolMap.get(alloc.ipamPoolName);
        if (!poolId) {
          this.stack.addLogs(LogLevel.ERROR, `${vpcItem.name}: unable to locate IPAM pool ${alloc.ipamPoolName}`);
          throw new Error(`Configuration validation failed at runtime.`);
        }
        vpc.addIpv4Cidr({ ipv4IpamPoolId: poolId, ipv4NetmaskLength: alloc.netmaskLength });
        additionalCidrs.push({ ipv4IpamPoolId: poolId, ipv4NetmaskLength: alloc.netmaskLength });
      }
    }
    return additionalCidrs;
  }

  /**
   * Create IPv6 CIDRs for a given VPC
   * @param vpc Vpc
   * @param vpcItem VpcConfig | VpcTemplatesConfig
   * @returns Ipv6VpcCidrBlock[]
   */
  private createIpv6Cidrs(vpc: Vpc, vpcItem: VpcConfig | VpcTemplatesConfig): Ipv6VpcCidrBlock[] {
    const ipv6Cidrs: Ipv6VpcCidrBlock[] = [];

    for (const vpcCidr of vpcItem.ipv6Cidrs ?? []) {
      const cidrProps = {
        amazonProvidedIpv6CidrBlock: vpcCidr.amazonProvided,
        ipv6CidrBlock: vpcCidr.cidrBlock,
        ipv6Pool: vpcCidr.byoipPoolId,
      };
      vpc.addIpv6Cidr(cidrProps);
      ipv6Cidrs.push(cidrProps);
    }
    return ipv6Cidrs;
  }

  /**
   * Add central endpoint tags to the given VPC if useCentralEndpoints is enabled
   * @param vpc
   * @param vpcItem
   * @param props
   * @returns
   */
  private addCentralEndpointTags(
    vpc: Vpc,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    centralEndpointVpc: VpcConfig | undefined,
  ): boolean {
    if (vpcItem.useCentralEndpoints) {
      if (!centralEndpointVpc) {
        this.stack.addLogs(LogLevel.ERROR, 'Attempting to use central endpoints with no Central Endpoints defined');
        throw new Error(`Configuration validation failed at runtime.`);
      }
      const centralEndpointVpcAccountId = this.stack.getVpcAccountIds(centralEndpointVpc).join();
      if (!centralEndpointVpcAccountId) {
        this.stack.addLogs(
          LogLevel.ERROR,
          'Attempting to use central endpoints without an account ID for the Central Endpoints defined',
        );
        throw new Error(`Configuration validation failed at runtime.`);
      }
      cdk.Tags.of(vpc).add('accelerator:use-central-endpoints', 'true');
      cdk.Tags.of(vpc).add('accelerator:central-endpoints-account-id', centralEndpointVpcAccountId!);
      return true;
    }
    return false;
  }

  /**
   * Determines whether flow logs are created for a given VPC
   * @param vpc
   * @param vpcItem
   * @param props
   *
   */
  private getVpcFlowLogConfig(
    vpc: Vpc,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    vpcFlowLogsNetworkConfig: VpcFlowLogsConfig | undefined,
    useExistingRoles: boolean,
    acceleratorPrefix: string,
  ) {
    let vpcFlowLogs: VpcFlowLogsConfig | undefined;

    if (vpcItem.vpcFlowLogs) {
      vpcFlowLogs = vpcItem.vpcFlowLogs;
    } else {
      vpcFlowLogs = vpcFlowLogsNetworkConfig;
    }

    if (vpcFlowLogs) {
      this.createVpcFlowLogs(vpc, vpcFlowLogs, useExistingRoles, acceleratorPrefix);
    } else {
      NagSuppressions.addResourceSuppressions(vpc, [
        { id: 'AwsSolutions-VPC7', reason: 'VPC does not have flow logs configured' },
      ]);
    }
  }

  /**
   * Function to create VPC flow logs
   * @param vpc
   * @param vpcItem
   * @param props
   *
   */
  private createVpcFlowLogs(
    vpc: Vpc,
    vpcFlowLogs: VpcFlowLogsConfig,
    useExistingRoles: boolean,
    acceleratorPrefix: string,
  ) {
    let logFormat: string | undefined = undefined;
    let destinationBucketArn: string | undefined;
    let overrideS3LogPath: string | undefined = undefined;

    if (vpcFlowLogs.destinations.includes('s3')) {
      destinationBucketArn = cdk.aws_ssm.StringParameter.valueForStringParameter(
        this.stack,
        this.stack.acceleratorResourceNames.parameters.flowLogsDestinationBucketArn,
      );

      if (vpcFlowLogs.destinationsConfig?.s3?.overrideS3LogPath) {
        overrideS3LogPath = vpcFlowLogs.destinationsConfig?.s3?.overrideS3LogPath;
      }
    }

    if (!vpcFlowLogs.defaultFormat) {
      logFormat = vpcFlowLogs.customFields.map(c => `$\{${c}}`).join(' ');
    }

    vpc.addFlowLogs({
      destinations: vpcFlowLogs.destinations,
      trafficType: vpcFlowLogs.trafficType,
      maxAggregationInterval: vpcFlowLogs.maxAggregationInterval,
      logFormat,
      logRetentionInDays: vpcFlowLogs.destinationsConfig?.cloudWatchLogs?.retentionInDays ?? this.stack.logRetention,
      encryptionKey: this.stack.cloudwatchKey,
      bucketArn: destinationBucketArn,
      useExistingRoles,
      acceleratorPrefix,
      overrideS3LogPath,
    });
  }

  /**
   * Delete default security group rules for a given VPC
   * @param vpc
   * @param vpcItem
   * @returns
   */
  private deleteDefaultSgRules(vpc: Vpc, vpcItem: VpcConfig | VpcTemplatesConfig): boolean {
    if (vpcItem.defaultSecurityGroupRulesDeletion) {
      this.stack.addLogs(LogLevel.INFO, `Delete default security group ingress and egress rules for ${vpcItem.name}`);
      new DeleteDefaultSecurityGroupRules(this.stack, pascalCase(`DeleteSecurityGroupRules-${vpcItem.name}`), {
        vpcId: vpc.vpcId,
        kmsKey: this.stack.cloudwatchKey,
        logRetentionInDays: this.stack.logRetention,
      });
      return true;
    }
    return false;
  }

  /**
   * Add dependency on deleting the default VPC to reduce risk of exceeding service limits
   * @param vpc
   * @param vpcItem
   * @returns
   */
  private addDefaultVpcDependency(vpc: Vpc, vpcItem: VpcConfig | VpcTemplatesConfig): void {
    if (this.deleteDefaultVpc) {
      this.stack.addLogs(LogLevel.INFO, `Adding dependency on deletion of the default VPC for ${vpcItem.name}`);
      vpc.node.addDependency(this.deleteDefaultVpc);
    }
  }

  /**
   * Create a VPC connection for a given VPC
   * @param vpcMap Map<string, Vpc>
   * @param props AcceleratorStackProps
   * @param customResourceHandler cdk.aws_lambda.IFunction | undefined
   * @returns Map<string, string>
   */
  private createVpnConnections(
    vpcMap: Map<string, Vpc>,
    customerGatewayConfig: CustomerGatewayConfig[] | undefined,
    customResourceHandler?: cdk.aws_lambda.IFunction,
  ): Map<string, string> {
    const vpnMap = new Map<string, string>();
    const ipv4Cgws = customerGatewayConfig?.filter(cgw => isIpv4(cgw.ipAddress));

    for (const cgw of ipv4Cgws ?? []) {
      for (const vpnItem of cgw.vpnConnections ?? []) {
        if (vpnItem.vpc && vpcMap.has(vpnItem.vpc)) {
          //
          // Get CGW ID and VPC
          const customerGatewayId = cdk.aws_ssm.StringParameter.valueForStringParameter(
            this.stack,
            this.stack.getSsmPath(SsmResourceType.CGW, [cgw.name]),
          );
          const vpc = getVpc(vpcMap, vpnItem.vpc) as Vpc;

          this.stack.addLogs(
            LogLevel.INFO,
            `Creating Vpn Connection with Customer Gateway ${cgw.name} to the VPC ${vpnItem.vpc}`,
          );
          const vpn = new VpnConnection(
            this.stack,
            this.setVgwVpnLogicalId(vpc, vpnItem.name),
            this.stack.setVpnProps({
              vpnItem,
              customerGatewayId,
              customResourceHandler,
              virtualPrivateGateway: vpc.virtualPrivateGatewayId,
            }),
          );
          vpnMap.set(`${vpc.name}_${vpnItem.name}`, vpn.vpnConnectionId);
          vpc.vpnConnections.push(vpn);
        }
      }
    }
    return vpnMap;
  }

  /**
   * Sets the logical ID of the VGW VPN.
   * Required for backward compatibility with previous versions --
   * takes into account the possibility of multiple VPNs to the same VGW.
   * @param vpc
   * @param vpnName
   * @returns
   */
  private setVgwVpnLogicalId(vpc: Vpc, vpnName: string): string {
    if (vpc.vpnConnections.length === 0) {
      return pascalCase(`${vpc.name}-VgwVpnConnection`);
    } else {
      return pascalCase(`${vpc.name}${vpnName}-VgwVpnConnection`);
    }
  }

  /**
   * Create cross-account/cross-region SSM parameters for site-to-site VPN connections
   * that must reference the TGW/TGW route table in cross-account VPN scenarios
   * @param vpcResources (VpcConfig | VpcTemplatesConfig)[]
   * @param vpcMap Map<string, Vpc>
   * @param customerGateways CustomerGatewayConfig[]
   * @returns Map<string, SsmParameterProps[]>
   */
  private createSharedParameters(
    vpcResources: (VpcConfig | VpcTemplatesConfig)[],
    vpcMap: Map<string, Vpc>,
    customerGateways?: CustomerGatewayConfig[],
  ): Map<string, SsmParameterProps[]> {
    const sharedParameterMap = new Map<string, SsmParameterProps[]>();
    const vpcNames = vpcResources.map(vpc => vpc.name);
    const vgwVpnCustomerGateways = customerGateways
      ? customerGateways.filter(cgw => cgw.vpnConnections?.filter(vpn => vpcNames.includes(vpn.vpc ?? '')))
      : [];
    const crossAcctFirewallReferenceCgws = vgwVpnCustomerGateways.filter(
      cgw => !isIpv4(cgw.ipAddress) && !this.stack.firewallVpcInScope(cgw),
    );

    for (const crossAcctCgw of crossAcctFirewallReferenceCgws) {
      const firewallVpcConfig = this.stack.getFirewallVpcConfig(crossAcctCgw);
      const accountIds = this.stack.getVpcAccountIds(firewallVpcConfig);
      const parameters = this.setCrossAccountSsmParameters(crossAcctCgw, vpcResources, vpcMap);

      if (parameters.length > 0) {
        this.stack.addLogs(
          LogLevel.INFO,
          `Putting cross-account/cross-region SSM parameters for VPC ${firewallVpcConfig.name}`,
        );
        // Put SSM parameters
        new PutSsmParameter(this.stack, pascalCase(`${crossAcctCgw.name}VgwVpnSharedParameters`), {
          accountIds,
          region: firewallVpcConfig.region,
          roleName: this.stack.acceleratorResourceNames.roles.crossAccountSsmParameterShare,
          kmsKey: this.stack.cloudwatchKey,
          logRetentionInDays: this.stack.logRetention,
          parameters,
          invokingAccountId: this.stack.account,
          acceleratorPrefix: this.stack.acceleratorPrefix,
        });
        sharedParameterMap.set(crossAcctCgw.name, parameters);
      }
    }
    return sharedParameterMap;
  }

  /**
   * Returns an array of SSM parameters for cross-account VGW VPN connections
   * @param cgw CustomerGatewayConfig
   * @param vpcResources (VpcConfig | VpcTemplatesConfig)[]
   * @param vpcMap Map<string, Vpc>
   * @returns SsmParameterProps[]
   */
  private setCrossAccountSsmParameters(
    cgw: CustomerGatewayConfig,
    vpcResources: (VpcConfig | VpcTemplatesConfig)[],
    vpcMap: Map<string, Vpc>,
  ) {
    const ssmParameters: SsmParameterProps[] = [];

    for (const vpnItem of cgw.vpnConnections ?? []) {
      if (vpnItem.vpc && vpcMap.has(vpnItem.vpc)) {
        //
        // Set VGW ID
        const vpcConfig = getVpcConfig(vpcResources, vpnItem.vpc);
        const vpc = getVpc(vpcMap, vpnItem.vpc) as Vpc;
        ssmParameters.push({
          name: this.stack.getSsmPath(SsmResourceType.CROSS_ACCOUNT_VGW, [cgw.name, vpcConfig.name]),
          value: vpc.virtualPrivateGatewayId ?? '',
        });
      }
    }
    return [...new Set(ssmParameters)];
  }
}
