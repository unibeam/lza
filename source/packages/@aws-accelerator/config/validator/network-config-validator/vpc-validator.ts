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
import { ShareTargets, isNetworkType } from '../../lib/common';
import {
  ApplicationLoadBalancerConfig,
  CustomizationsConfig,
  Ec2FirewallInstanceConfig,
} from '../../lib/customizations-config';
import {
  NetworkAclSubnetSelection,
  NetworkConfig,
  NfwFirewallConfig,
  PrefixListSourceConfig,
  ResolverRuleConfig,
  RouteTableEntryConfig,
  SecurityGroupConfig,
  SecurityGroupRuleConfig,
  SecurityGroupSourceConfig,
  SubnetConfig,
  SubnetSourceConfig,
  TransitGatewayAttachmentConfig,
  TransitGatewayConfig,
  VpcConfig,
  VpcTemplatesConfig,
} from '../../lib/network-config';
import { NetworkValidatorFunctions } from './network-validator-functions';
import * as cdk from 'aws-cdk-lib';

/**
 * Class to validate Vpcs
 */
export class VpcValidator {
  private centralEndpointVpcRegions: string[];
  private customizationsConfig?: CustomizationsConfig;
  constructor(
    values: NetworkConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
    customizationsConfig?: CustomizationsConfig,
  ) {
    this.customizationsConfig = customizationsConfig;
    //
    // Determine if there is a central endpoint VPC
    //
    this.centralEndpointVpcRegions = this.getCentralEndpointVpcs(values, helpers, errors);
    //
    // Validate VPC names are unique
    this.validateVpcNames(values, helpers, errors);
    //
    // Validate VPC template deployment target ou names
    this.validateVpcTemplatesDeploymentTargetOUs(values, helpers, errors);
    //
    // Validate Vpc templates deployment account names
    //
    this.validateVpcTemplatesDeploymentTargetAccounts(values, helpers, errors);
    //
    // Validate vpc account name
    //
    this.validateVpcAccountName(values, helpers, errors);
    //
    // Validate vpc tgw name
    //
    this.validateVpcTgwAccountName(values, helpers, errors);
    //
    // Validate VPC configurations
    //
    this.validateVpcConfiguration(values, helpers, errors);
    //
    // Validate Outpost and Local Gateway (LGW) configurations
    //
    this.validateOutpostConfiguration(values, helpers, errors);
    //
    // Validate VPC peering configurations
    //
    this.validateVpcPeeringConfiguration(values, errors);
    //
    // Validate Default VPC Configuration
    //
    this.validateDefaultVpcConfiguration(values, helpers, errors);
  }

  private getCentralEndpointVpcs(
    values: NetworkConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ): string[] {
    const vpcs = [...values.vpcs, ...(values.vpcTemplates ?? [])];
    const centralVpcs: VpcConfig[] = [];
    const unsupportedRegions = ['us-gov-west-1', 'us-gov-east-1'];
    // Get VPCs marked as central; do not allow VPC templates
    vpcs.forEach(vpc => {
      if (vpc.interfaceEndpoints?.central && !isNetworkType<VpcConfig>('IVpcConfig', vpc)) {
        errors.push(`[VPC ${vpc.name}]: cannot define a VPC template as a central interface endpoint VPC`);
      }
      if (vpc.interfaceEndpoints?.central && isNetworkType<VpcConfig>('IVpcConfig', vpc)) {
        centralVpcs.push(vpc);
      }
    });

    // Check regions
    const vpcRegions: string[] = [];
    centralVpcs.forEach(vpc => vpcRegions.push(vpc.region));
    if (helpers.hasDuplicates(vpcRegions)) {
      errors.push(
        `More than one central endpoint VPC configured in a single region. One central endpoint VPC per region is supported. Central endpoint VPC regions configured: ${vpcRegions}`,
      );
    }
    if (vpcRegions.some(region => unsupportedRegions.includes(region))) {
      errors.push(
        `Central endpoints VPC configured in an unsupported region. Central endpoint VPC regions configured: ${vpcRegions}`,
      );
    }
    return vpcRegions;
  }

  /**
   * Validate uniqueness of VPC names
   * @param values
   * @param helpers
   * @param errors
   */
  private validateVpcNames(values: NetworkConfig, helpers: NetworkValidatorFunctions, errors: string[]) {
    const vpcs = [...values.vpcs, ...(values.vpcTemplates ?? [])];
    const vpcNames = vpcs.map(vpc => {
      return vpc.name;
    });

    // Validate no VPC names are duplicated
    if (helpers.hasDuplicates(vpcNames)) {
      errors.push(`Duplicate VPC/VPC template names exist. VPC names must be unique. VPC names in file: ${vpcNames}`);
    }
  }

  /**
   * Function to validate VPC template deployment target ou names
   * @param values
   * @param helpers
   * @param errors
   */
  private validateVpcTemplatesDeploymentTargetOUs(
    values: NetworkConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    for (const vpc of values.vpcTemplates ?? []) {
      for (const ou of vpc.deploymentTargets?.organizationalUnits ?? []) {
        if (!helpers.ouExists(ou)) {
          errors.push(
            `Deployment target OU ${ou} for VPC template ${vpc.name} does not exist in organization-config.yaml file`,
          );
        }
      }
    }
  }

  /**
   * Function to validate existence of VPC deployment target accounts
   * Make sure deployment target accounts are part of account config file
   * @param values
   * @param helpers
   * @param errors
   */
  private validateVpcTemplatesDeploymentTargetAccounts(
    values: NetworkConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    for (const vpc of values.vpcTemplates ?? []) {
      for (const account of vpc.deploymentTargets?.accounts ?? []) {
        if (!helpers.accountExists(account)) {
          errors.push(
            `Deployment target account ${account} for VPC template ${vpc.name} does not exist in accounts-config.yaml file`,
          );
        }
      }
    }
  }

  /**
   * Function to validate existence of vpc account name
   * Make sure target account is part of account config file
   * @param values
   * @param helpers
   * @param errors
   */
  private validateVpcAccountName(values: NetworkConfig, helpers: NetworkValidatorFunctions, errors: string[]) {
    for (const vpcItem of values.vpcs ?? []) {
      if (!helpers.accountExists(vpcItem.account)) {
        errors.push(
          `VPC "${vpcItem.name}" account name "${vpcItem.account}" does not exist in accounts-config.yaml file`,
        );
      }
    }
  }

  /**
   * Function to validate existence of vpc transit gateway account name
   * Make sure deployment target accounts are part of account config file
   * @param values
   */
  private validateVpcTgwAccountName(values: NetworkConfig, helpers: NetworkValidatorFunctions, errors: string[]) {
    for (const vpcItem of values.vpcs ?? []) {
      for (const tgwAttachment of vpcItem.transitGatewayAttachments ?? []) {
        if (!helpers.accountExists(tgwAttachment.transitGateway.account)) {
          errors.push(
            `VPC "${vpcItem.name}" TGW attachment "${tgwAttachment.transitGateway.name}" account name "${tgwAttachment.transitGateway.account}" does not exist in accounts-config.yaml file`,
          );
        }
      }
    }
  }

  /**
   * Validate route tables for a given VPC
   * @param values
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateRouteTables(
    values: NetworkConfig,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    // Validate route tables names
    this.validateRouteTableNames(vpcItem, helpers, errors);
    // Validate route entries
    this.validateRouteTableEntries(values, vpcItem, helpers, errors);
  }

  /**
   * Validate route table and route entry names
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateRouteTableNames(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    const routeTableNames: string[] = [];

    vpcItem.routeTables?.forEach(routeTable => {
      const routeEntryNames: string[] = [];
      routeTableNames.push(routeTable.name);

      routeTable.routes?.forEach(route => {
        routeEntryNames.push(route.name);
      });

      // Check if there are duplicate route entry names
      if (helpers.hasDuplicates(routeEntryNames)) {
        errors.push(
          `[VPC ${vpcItem.name} route table ${routeTable.name}]: duplicate route entry names defined. Route entry names must be unique per route table. Route entry names configured: ${routeEntryNames}`,
        );
      }
    });

    // Check if there are duplicate route table names
    if (helpers.hasDuplicates(routeTableNames)) {
      errors.push(
        `[VPC ${vpcItem.name}]: duplicate route table names defined. Route table names must be unique per VPC. Route table names configured: ${routeTableNames}`,
      );
    }
  }

  /**
   * Validate route entries have a valid destination configured
   * @param routeTableEntryItem
   * @param routeTableName
   * @param vpcName
   */
  private validateRouteEntryDestination(
    routeTableEntryItem: RouteTableEntryConfig,
    routeTableName: string,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    values: NetworkConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    if (routeTableEntryItem.destinationPrefixList) {
      // Check if a CIDR destination is also defined
      if (routeTableEntryItem.destination || routeTableEntryItem.ipv6Destination) {
        errors.push(
          `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} using destination and destinationPrefixList. Please choose only one destination type`,
        );
      }

      // Throw error if network firewall or GWLB are the target
      if (['networkFirewall', 'gatewayLoadBalancerEndpoint'].includes(routeTableEntryItem.type!)) {
        errors.push(
          `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} with type ${routeTableEntryItem.type} does not support destinationPrefixList`,
        );
      }

      // Throw error if prefix list doesn't exist
      if (!values.prefixLists?.find(item => item.name === routeTableEntryItem.destinationPrefixList)) {
        errors.push(
          `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} destinationPrefixList ${routeTableEntryItem.destinationPrefixList} does not exist`,
        );
      }
    } else if (routeTableEntryItem.destination || routeTableEntryItem.ipv6Destination) {
      // Validate the destination CIDR or subnet
      this.validateRouteEntryDestinationCidr(routeTableEntryItem, routeTableName, vpcItem, helpers, errors);
    } else if (!['vpcPeering'].includes(routeTableEntryItem.type!)) {
      errors.push(
        `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} must define either destinationPrefixList, destination or ipv6Destination if type is not vpcPeering or gatewayEndpoint`,
      );
    }
  }

  /**
   * Validate route entry destination CIDR or subnet reference is valid
   * @param routeTableEntryItem
   * @param routeTableName
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateRouteEntryDestinationCidr(
    routeTableEntryItem: RouteTableEntryConfig,
    routeTableName: string,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    if (!routeTableEntryItem.destination && !routeTableEntryItem.ipv6Destination) {
      errors.push(
        `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} does not have a destination defined`,
      );
    } else {
      if (routeTableEntryItem.destination && routeTableEntryItem.ipv6Destination) {
        errors.push(
          `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} has both a destination and ipv6Destination defined. Please choose only one.`,
        );
      }
      if (
        !helpers.isValidIpv4Cidr(routeTableEntryItem.destination) &&
        !helpers.isValidIpv6Cidr(routeTableEntryItem.ipv6Destination)
      ) {
        // Check if subnet exists in the VPC
        if (!helpers.getSubnet(vpcItem, routeTableEntryItem.ipv6Destination ?? routeTableEntryItem.destination!)) {
          errors.push(
            `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${
              routeTableEntryItem.name
            } destination "${
              routeTableEntryItem.ipv6Destination ?? routeTableEntryItem.destination
            }" is not a valid IPv4/v6 CIDR or subnet name`,
          );
        }
        // Validate target type
        if (!['natGateway', 'networkFirewall', 'gatewayLoadBalancerEndpoint'].includes(routeTableEntryItem.type!)) {
          errors.push(
            `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} destination "${routeTableEntryItem.destination}" is not valid. Route entry type ${routeTableEntryItem.type} does not support dynamic subnet destinations`,
          );
        }
      }
    }
  }

  /**
   * Validate IGW routes are associated with a VPC with an IGW attached
   * @param routeTableEntryItem
   * @param routeTableName
   * @param vpcItem
   */
  private validateIgwRouteEntry(
    routeTableEntryItem: RouteTableEntryConfig,
    routeTableName: string,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    errors: string[],
  ) {
    if (!vpcItem.internetGateway) {
      errors.push(
        `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} is targeting an IGW, but no IGW is attached to the VPC`,
      );
    }
  }

  /**
   * Validate EIGW routes are associated with a VPC with an EIGW attached
   * @param routeTableEntryItem
   * @param routeTableName
   * @param vpcItem
   */
  private validateEigwRouteEntry(
    routeTableEntryItem: RouteTableEntryConfig,
    routeTableName: string,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    errors: string[],
  ) {
    if (!vpcItem.egressOnlyIgw) {
      errors.push(
        `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} is targeting an Egress-only IGW, but no EIGW is attached to the VPC. Please add "egressOnlyIgw: true" to the VPC configuration.`,
      );
    }
  }

  /**
   * Validate VGW routes are associated with a VPC with an Virtual Private Gateway attached
   * @param routeTableEntryItem
   * @param routeTableName
   * @param vpcItem
   */
  private validateVgwRouteEntry(
    routeTableEntryItem: RouteTableEntryConfig,
    routeTableName: string,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    errors: string[],
  ) {
    if (!vpcItem.virtualPrivateGateway) {
      errors.push(
        `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} is targeting an VGW, but no VGW is attached to the VPC`,
      );
    }
  }

  /**
   * Validate LGW routes are associated with a VPC with an Outpost and Local Gateway attached
   * @param routeTableEntryItem
   * @param routeTableName
   * @param vpcItem
   */
  private validateLgwRouteEntry(
    routeTableEntryItem: RouteTableEntryConfig,
    routeTableName: string,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    errors: string[],
  ) {
    if (!('outposts' in vpcItem)) {
      errors.push(
        `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} is targeting an LGW, but no Outpost and LGW are associated with the VPC`,
      );
    }

    const vpc = vpcItem as VpcConfig;
    let lgwNameFound = false;
    for (const outpost of vpc.outposts ?? []) {
      if (outpost.localGateway?.name === routeTableEntryItem.target) {
        lgwNameFound = true;
      }
    }

    if (!lgwNameFound) {
      errors.push(
        `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} is targeting LGW ${routeTableEntryItem.target}, but the LGW is not associated with the VPC`,
      );
    }
  }

  /**
   * Validate route table entries have a valid target configured
   * @param routeTableEntryItem
   * @param routeTableName
   * @param vpcItem
   * @param values
   * @param helpers
   * @param errors
   */
  private validateRouteEntryTarget(
    routeTableEntryItem: RouteTableEntryConfig,
    routeTableName: string,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    values: NetworkConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    const gwlbs = values.centralNetworkServices?.gatewayLoadBalancers;
    const networkFirewalls = values.centralNetworkServices?.networkFirewall?.firewalls ?? [];
    const tgws = values.transitGateways;
    const vpcs = [...values.vpcs, ...(values.vpcTemplates ?? [])];
    const vpcPeers = values.vpcPeering;

    // Throw error if no target defined
    if (!routeTableEntryItem.target) {
      errors.push(
        `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} of type ${routeTableEntryItem.type} must include a target`,
      );
    }

    // Throw error if GWLB endpoint doesn't exist
    if (
      routeTableEntryItem.type === 'gatewayLoadBalancerEndpoint' &&
      !gwlbs?.find(item => item.endpoints.find(endpoint => endpoint.name === routeTableEntryItem.target))
    ) {
      errors.push(
        `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} target ${routeTableEntryItem.target} does not exist`,
      );
    }

    //
    // Validate network firewall route entry
    this.validateNfwRouteEntry(routeTableEntryItem, routeTableName, vpcItem, networkFirewalls, helpers, errors);

    // Validate network interface route entry
    if (routeTableEntryItem.type === 'networkInterface') {
      this.validateNetworkInterfaceRouteEntry(routeTableEntryItem, routeTableName, vpcItem, helpers, errors);
    }

    // Throw error if NAT gateway doesn't exist
    if (
      routeTableEntryItem.type === 'natGateway' &&
      !vpcs.find(item => item.natGateways?.find(nat => nat.name === routeTableEntryItem.target))
    ) {
      errors.push(
        `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} target ${routeTableEntryItem.target} does not exist`,
      );
    }

    // Throw error if transit gateway doesn't exist
    if (routeTableEntryItem.type === 'transitGateway' && !tgws.find(item => item.name === routeTableEntryItem.target)) {
      errors.push(
        `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} target ${routeTableEntryItem.target} does not exist`,
      );
    }

    // Throw error if VPC peering doesn't exist
    if (
      routeTableEntryItem.type === 'vpcPeering' &&
      !vpcPeers?.find(item => item.name === routeTableEntryItem.target)
    ) {
      errors.push(
        `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} target ${routeTableEntryItem.target} does not exist`,
      );
    }
  }

  /**
   * Validate network firewall route entry
   * @param routeTableEntryItem
   * @param routeTableName
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateNetworkInterfaceRouteEntry(
    routeTableEntryItem: RouteTableEntryConfig,
    routeTableName: string,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    if (!routeTableEntryItem.target) {
      errors.push(
        `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} with type networkInterface requires the 'target' property`,
      );
    }

    if (
      !helpers.matchesRegex(routeTableEntryItem.target!, '\\${ACCEL_LOOKUP::EC2:ENI_([a-zA-Z0-9-/:_]*)}') &&
      !helpers.matchesRegex(routeTableEntryItem.target!, '^eni-(\\d|[a-f]){17}$')
    ) {
      errors.push(
        `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} has invalid target. Target may be an ENI Id or accepted pattern: "^\\$\{ACCEL_LOOKUP::EC2:ENI_([a-zA-Z0-9-/:]*)}" Value entered: ${routeTableEntryItem.target} `,
      );
    }

    if (helpers.matchesRegex(routeTableEntryItem.target!, '\\${ACCEL_LOOKUP::EC2:ENI_([a-zA-Z0-9-/:_]*)}')) {
      if (!this.isValidFirewallReference(routeTableEntryItem, vpcItem.name, errors)) {
        errors.push(
          `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} has invalid lookup target. Accepted pattern: "^\\$\{ACCEL_LOOKUP::EC2:ENI_([a-zA-Z0-9-/:]*)}" Value entered: ${routeTableEntryItem.target}`,
        );
      }
    }
  }

  /**
   * Validates that the referenced firewall exists in customizations config
   * @param routeTableEntryItem: RouteTableEntryConfig,
   * @param errors string[]
   * @returns boolean
   */
  private isValidFirewallReference(
    routeTableEntryItem: RouteTableEntryConfig,
    vpcName: string,
    errors: string[],
  ): boolean {
    //
    // Check that customizations config is defined
    if (!this.customizationsConfig) {
      errors.push(
        `[Route Table entry: ${routeTableEntryItem.name}]: EC2 firewall reference variable entered but customizations-config.yaml is not defined.`,
      );
      return false;
    } else {
      // Check that firewall exists
      const lookupComponents = routeTableEntryItem.target!.split(':');
      const eniIndex = lookupComponents[3].split('_').pop();
      const firewallName = lookupComponents[4].replace(/\}$/, '');
      const firewall = this.customizationsConfig.firewalls?.instances?.find(instance => instance.name === firewallName);

      if (!firewall) {
        errors.push(
          `[Route Table entry: ${routeTableEntryItem.name}]: EC2 firewall instance "${firewallName}" is not defined in customizations-config.yaml`,
        );
        return false;
      }

      if (!eniIndex) {
        errors.push(
          `[Route Table entry: ${routeTableEntryItem.name}]: Unable to parse ENI index of EC2 firewall instance "${firewallName}" from pattern ${routeTableEntryItem.target}`,
        );
        return false;
      }

      if (vpcName !== firewall.vpc) {
        errors.push(
          `[Route Table entry: ${routeTableEntryItem.name}]: Firewall "${firewallName}" in route target ${routeTableEntryItem.target} must exist in the same VPC the route is created`,
        );
        return false;
      }
      //
      // Check device index
      this.validateFirewallInterface(routeTableEntryItem.name, firewall, eniIndex, errors);
    }
    return true;
  }

  /**
   * Validates that the referenced network interface has an elastic IP associated or sourceDestCheck set to false
   * @param routeTableEntryName string
   * @param firewall Ec2FirewallInstanceConfig
   * @param eniIndex string
   * @param errors string[]
   */
  private validateFirewallInterface(
    routeTableEntryName: string,
    firewall: Ec2FirewallInstanceConfig,
    eniIndex: string,
    errors: string[],
  ) {
    if (!firewall.launchTemplate.networkInterfaces) {
      errors.push(
        `[Route Table entry: ${routeTableEntryName}]: EC2 firewall instance "${firewall.name}" launch template does not have network interfaces defined in customizations-config.yaml`,
      );
    } else {
      const deviceIndex = Number(eniIndex);
      if (deviceIndex > firewall.launchTemplate.networkInterfaces.length - 1) {
        errors.push(
          `[Route Table entry: ${routeTableEntryName}]: EC2 firewall instance "${firewall.name}" device index ${deviceIndex} does not exist in customizations-config.yaml`,
        );
      } else {
        const networkInterface = firewall.launchTemplate.networkInterfaces[deviceIndex];
        if (
          !networkInterface.associateElasticIp &&
          (networkInterface.sourceDestCheck === undefined || networkInterface.sourceDestCheck === true)
        ) {
          errors.push(
            `[Route Table entry: ${routeTableEntryName}]: EC2 firewall instance "${firewall.name}" device index ${deviceIndex} must have the associateElasticIp set to true or sourceDestCheck property set to false in customizations-config.yaml`,
          );
        }
      }
    }
  }

  /**
   * Validate route table entries
   * @param values
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateRouteTableEntries(
    values: NetworkConfig,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    vpcItem.routeTables?.forEach(routeTableItem => {
      routeTableItem.routes?.forEach(entry => {
        // Validate destination exists
        if (entry.type && entry.type !== 'gatewayEndpoint') {
          this.validateRouteEntryDestination(entry, routeTableItem.name, vpcItem, values, helpers, errors);
        }

        // Validate IGW route
        if (entry.type && entry.type === 'internetGateway') {
          this.validateIgwRouteEntry(entry, routeTableItem.name, vpcItem, errors);
        }

        // Validate IGW route
        if (entry.type && entry.type === 'egressOnlyIgw') {
          this.validateEigwRouteEntry(entry, routeTableItem.name, vpcItem, errors);
        }

        // Validate VGW route
        if (entry.type && entry.type === 'virtualPrivateGateway') {
          this.validateVgwRouteEntry(entry, routeTableItem.name, vpcItem, errors);
        }

        // Validate LGW route
        if (entry.type && entry.type === 'localGateway') {
          this.validateLgwRouteEntry(entry, routeTableItem.name, vpcItem, errors);
        }

        // Validate target exists
        if (
          entry.type &&
          [
            'gatewayLoadBalancerEndpoint',
            'natGateway',
            'networkFirewall',
            'networkInterface',
            'transitGateway',
            'vpcPeering',
          ].includes(entry.type)
        ) {
          this.validateRouteEntryTarget(entry, routeTableItem.name, vpcItem, values, helpers, errors);
        }
      });
    });
  }

  /**
   * Validate network firewall route entry
   * @param routeTableEntryItem
   * @param routeTableName
   * @param vpcItem
   * @param networkFirewalls
   * @param helpers
   * @param errors
   */
  private validateNfwRouteEntry(
    routeTableEntryItem: RouteTableEntryConfig,
    routeTableName: string,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    networkFirewalls: NfwFirewallConfig[],
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    //
    // Validate network firewall target exists
    if (routeTableEntryItem.type === 'networkFirewall') {
      const nfwTarget = networkFirewalls.find(item => item.name === routeTableEntryItem.target);
      if (!nfwTarget) {
        errors.push(
          `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} target Network Firewall "${routeTableEntryItem.target}" does not exist in network-config.yaml`,
        );
      } else {
        if (nfwTarget.vpc !== vpcItem.name) {
          errors.push(
            `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} target Network Firewall "${routeTableEntryItem.target}" must be deployed to the same VPC as the route table. Configured VPC target: ${nfwTarget.vpc}`,
          );
        } else {
          //
          // Validate target AZ exists
          this.validateNfwRouteEntryTarget(routeTableEntryItem, routeTableName, vpcItem, nfwTarget, helpers, errors);
        }
      }
    }
  }

  /**
   * Validate network firewall route entry AZ target
   * @param routeTableEntryItem
   * @param routeTableName
   * @param vpcItem
   * @param nfwTarget
   * @param helpers
   * @param errors
   */
  private validateNfwRouteEntryTarget(
    routeTableEntryItem: RouteTableEntryConfig,
    routeTableName: string,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    nfwTarget: NfwFirewallConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    const endpointAzs: (string | number)[] = [];
    //
    // Get subnet availability zones
    nfwTarget.subnets.forEach(subnetItem => {
      const subnet = helpers.getSubnet(vpcItem, subnetItem);
      if (subnet && subnet.availabilityZone) {
        endpointAzs.push(subnet.availabilityZone);
      }
    });
    //
    // Throw error if network firewall target AZ doesn't exist
    if (!routeTableEntryItem.targetAvailabilityZone) {
      errors.push(
        `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} with type networkFirewall must include targetAvailabilityZone`,
      );
    } else {
      //
      // Validate AZ is correct format
      if (
        typeof routeTableEntryItem.targetAvailabilityZone === 'string' &&
        !helpers.matchesRegex(routeTableEntryItem.targetAvailabilityZone, '^[a-z]{1}$')
      ) {
        errors.push(
          `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} target AZ "${routeTableEntryItem.targetAvailabilityZone}" is not in the correct format. AZ must be a single alphanumeric character.`,
        );
      }
      if (
        typeof routeTableEntryItem.targetAvailabilityZone === 'number' &&
        !helpers.matchesRegex(routeTableEntryItem.targetAvailabilityZone.toString(), '^[0-9]{1}$')
      ) {
        errors.push(
          `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} target AZ "${routeTableEntryItem.targetAvailabilityZone}" is not in the correct format. AZ must be a single alphanumeric character.`,
        );
      }
      //
      // Validate endpoint AZ exists
      if (!endpointAzs.includes(routeTableEntryItem.targetAvailabilityZone)) {
        errors.push(
          `[Route table ${routeTableName} for VPC ${vpcItem.name}]: route entry ${routeTableEntryItem.name} target AZ "${routeTableEntryItem.targetAvailabilityZone}" does not exist for Network Firewall "${routeTableEntryItem.target}". Configured AZs: ${endpointAzs}`,
        );
      }
    }
  }

  /**
   * Validate IPAM allocations for a given VPC
   * @param vpcItem
   * @param values
   * @param errors
   */
  private validateIpamAllocations(vpcItem: VpcConfig | VpcTemplatesConfig, values: NetworkConfig, errors: string[]) {
    const ipams = values.centralNetworkServices?.ipams;
    vpcItem.ipamAllocations?.forEach(alloc => {
      const ipamPool = ipams?.find(ipam => ipam.pools?.find(pool => pool.name === alloc.ipamPoolName));
      // Check if targeted IPAM exists
      if (!ipamPool) {
        errors.push(`[VPC ${vpcItem.name}]: target IPAM pool ${alloc.ipamPoolName} is not defined`);
      }
      // Validate prefix length
      if (ipamPool && !this.isValidIpv4PrefixLength(alloc.netmaskLength)) {
        errors.push(
          `[VPC ${vpcItem.name} allocation ${alloc.ipamPoolName}]: netmaskLength cannot be larger than 16 or smaller than 28`,
        );
      }
    });

    vpcItem.subnets?.forEach(subnet => {
      // Check if allocation is created for VPC
      if (
        subnet.ipamAllocation &&
        !vpcItem.ipamAllocations?.find(alloc => alloc.ipamPoolName === subnet.ipamAllocation!.ipamPoolName)
      ) {
        errors.push(
          `[VPC ${vpcItem.name} subnet ${subnet.name}]: target IPAM pool ${subnet.ipamAllocation.ipamPoolName} is not a source pool of the VPC`,
        );
      }
      // Check if targeted IPAM pool exists
      if (
        subnet.ipamAllocation &&
        !ipams?.find(ipam => ipam.pools?.find(pool => pool.name === subnet.ipamAllocation!.ipamPoolName))
      ) {
        errors.push(
          `[VPC ${vpcItem.name} subnet ${subnet.name}]: target IPAM pool ${subnet.ipamAllocation.ipamPoolName} is not defined`,
        );
      }
      // Validate prefix length
      if (subnet.ipamAllocation && !this.isValidIpv4PrefixLength(subnet.ipamAllocation.netmaskLength)) {
        errors.push(
          `[VPC ${vpcItem.name} subnet ${subnet.name}]: netmaskLength cannot be larger than 16 or smaller than 28`,
        );
      }
    });
  }

  /**
   * Function to validate conditional dependencies for Outpost and Local Gateway configurations.
   * @param values
   */
  private validateOutpostConfiguration(values: NetworkConfig, helpers: NetworkValidatorFunctions, errors: string[]) {
    //
    // Validate that local gateways do not have the same name across different outposts
    //
    this.validateLocalGatewayNames(values, helpers, errors);
    //
    // Validate that all outpost names are unique
    //
    this.validateOutpostNames(values, helpers, errors);
  }

  /**
   * Function to validate conditional dependencies for VPC configurations.
   * @param values
   */
  private validateVpcConfiguration(values: NetworkConfig, helpers: NetworkValidatorFunctions, errors: string[]) {
    const vpcs = [...values.vpcs, ...(values.vpcTemplates ?? [])] ?? [];
    vpcs.forEach(vpcItem => {
      //
      // Validate VPC structure
      //
      const allValid = this.validateVpcStructure(vpcItem, errors);
      if (allValid) {
        //
        // Validate VPC CIDRs
        //
        this.validateVpcCidrs(vpcItem, helpers, errors);
        //
        // Validate DHCP options
        //
        this.validateDhcpOptions(values, vpcItem, helpers, errors);
        //
        // Validate DNS firewall rule groups
        //
        this.validateDnsFirewallRuleGroups(values, vpcItem, helpers, errors);
        //
        // Validate endpoint policies
        //
        this.validateEndpointPolicies(values, vpcItem, errors);
        //
        // Validate gateway endpoints
        //
        this.validateGatewayEndpoints(vpcItem, helpers, errors);
        //
        // Validate interface endpoints
        //
        this.validateInterfaceEndpoints(vpcItem, helpers, errors);
        //
        // Validate IPAM allocations
        //
        this.validateIpamAllocations(vpcItem, values, errors);
        //
        // Validate NAT gateways
        //
        this.validateNatGateways(vpcItem, helpers, errors);
        //
        // Validate NACLs
        //
        this.validateNacls(vpcItem, helpers, errors);
        //
        // Validate query logs
        //
        this.validateQueryLogs(values, vpcItem, helpers, errors);
        //
        // Validate resolver rules
        //
        this.validateResolverRules(values, vpcItem, helpers, errors);
        //
        // Validate route tables
        //
        this.validateRouteTables(values, vpcItem, helpers, errors);
        //
        // Validate security groups
        //
        this.validateSecurityGroups(values, vpcItem, helpers, errors);
        //
        // Validate subnets
        //
        this.validateSubnets(vpcItem, helpers, errors);
        //
        // Validate transit gateway attachments
        //
        this.validateTgwAttachments(values, vpcItem, helpers, errors);
        //
        // Validate ACM shared targets
        //
        this.validateAcmSharesToAlbShares(values, vpcItem, helpers, errors);
      }
    });
  }

  private isValidIpv4PrefixLength(prefix: number): boolean {
    return prefix >= 16 && prefix <= 28;
  }

  private isValidIpv6VpcPrefixLength(prefix: number): boolean {
    return prefix >= 44 && prefix <= 60 && prefix % 4 === 0;
  }

  private isValidIpv6SubnetPrefixLength(prefix: number): boolean {
    return prefix >= 44 && prefix <= 64 && prefix % 4 === 0;
  }

  /**
   * Validate the base structure of the VPC object is correct
   * @param vpcItem
   * @param errors
   * @returns
   */
  private validateVpcStructure(vpcItem: VpcConfig | VpcTemplatesConfig, errors: string[]): boolean {
    let allValid = true;
    // Validate the VPC doesn't have a static CIDR and IPAM defined
    if (vpcItem.cidrs && vpcItem.ipamAllocations) {
      allValid = false;
      errors.push(`[VPC ${vpcItem.name}]: Both a CIDR and IPAM allocation are defined. Please choose only one`);
    }
    // Validate the VPC doesn't have a static CIDR and IPAM defined
    if (!vpcItem.cidrs && !vpcItem.ipamAllocations) {
      allValid = false;
      errors.push(`[VPC ${vpcItem.name}]: Neither a CIDR or IPAM allocation are defined. Please define one property`);
    }
    // Validate there is at least one IPv4 CIDR assigned to the VPC
    if (vpcItem.ipv6Cidrs && !vpcItem.cidrs && !vpcItem.ipamAllocations) {
      allValid = false;
      errors.push(
        `[VPC ${vpcItem.name}]: A VPC must have at least one IPv4 CIDR defined. Please specify either an IPv4 static CIDR or IPAM allocation.`,
      );
    }
    // Validate that a BYOP pool is defined if using a static IPv6 CIDR
    vpcItem.ipv6Cidrs?.forEach(ipv6Cidr => {
      if (ipv6Cidr.cidrBlock && !ipv6Cidr.byoipPoolId) {
        allValid = false;
        errors.push(
          `[VPC ${vpcItem.name}]: IPv6 static CIDR block defined without specifying a BYOIP address pool ID. Please specify a pool ID or choose an Amazon-provided IPv6 CIDR instead`,
        );
      }
      if (ipv6Cidr.amazonProvided && (ipv6Cidr.byoipPoolId || ipv6Cidr.cidrBlock)) {
        allValid = false;
        errors.push(
          `[VPC ${vpcItem.name}]: IPv6 static CIDR block defined with "amazonProvided: true" and other property elements. Please choose either amazonProvided or a static IPv6 CIDR from a BYOIP address pool.`,
        );
      }
    });
    // If the VPC is using central endpoints, ensure there is a central endpoints VPC in regions
    if (vpcItem.useCentralEndpoints && !this.centralEndpointVpcRegions.includes(vpcItem.region)) {
      allValid = false;
      errors.push(`[VPC ${vpcItem.name}]: useCentralEndpoints is true, but no central endpoint VPC defined in region`);
    }
    vpcItem.routeTables?.forEach(routeTableItem => {
      // Throw error if gateway association exists but no internet gateway
      if (routeTableItem.gatewayAssociation === 'internetGateway' && !vpcItem.internetGateway) {
        allValid = false;
        errors.push(
          `[Route table ${routeTableItem.name} for VPC ${vpcItem.name}]: attempting to configure a gateway association with no IGW attached to the VPC!`,
        );
      }
      if (routeTableItem.gatewayAssociation === 'virtualPrivateGateway' && !vpcItem.virtualPrivateGateway) {
        allValid = false;
        errors.push(
          `[Route table ${routeTableItem.name} for VPC ${vpcItem.name}]: attempting to configure a gateway association with no VGW attached to the VPC!`,
        );
      }
    });
    return allValid;
  }

  /**
   * Validate VPC CIDRs
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateVpcCidrs(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    // Validate IPv4 CIDRs
    vpcItem.cidrs?.forEach(cidr => {
      if (!helpers.isValidIpv4Cidr(cidr)) {
        errors.push(`[VPC ${vpcItem.name}]: IPv4 CIDR "${cidr}" is invalid. Value must be a valid IPv4 CIDR range`);
      }
      // Validate prefix
      const prefix = helpers.isValidIpv4Cidr(cidr) ? cidr.split('/')[1] : undefined;
      if (prefix && !this.isValidIpv4PrefixLength(parseInt(prefix))) {
        errors.push(
          `[VPC ${vpcItem.name}]: IPv4 CIDR "${cidr}" is invalid. CIDR prefix cannot be larger than /16 or smaller than /28`,
        );
      }
    });
    // Validate IPv6 CIDRs
    vpcItem.ipv6Cidrs?.forEach(ipv6Cidr => {
      const cidrRange = ipv6Cidr.cidrBlock;
      if (cidrRange && !helpers.isValidIpv6Cidr(cidrRange)) {
        errors.push(
          `[VPC ${vpcItem.name}]: IPv6 CIDR "${ipv6Cidr.cidrBlock}" is invalid. Value must be a valid IPv6 CIDR range`,
        );
      }
      // Validate prefix
      const ipv6Prefix = cidrRange && helpers.isValidIpv6Cidr(cidrRange) ? cidrRange.split('/')[1] : undefined;
      if (ipv6Prefix && !this.isValidIpv6VpcPrefixLength(parseInt(ipv6Prefix))) {
        errors.push(
          `[VPC ${vpcItem.name}]: IPv6 CIDR "${cidrRange}" is invalid. CIDR prefix cannot be larger than /44 or smaller than /60 and must be in an increment of /4`,
        );
      }
    });
  }

  /**
   * Validate DHCP options
   * @param values
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateDhcpOptions(
    values: NetworkConfig,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    if (vpcItem.dhcpOptions) {
      const optSet = values.dhcpOptions?.find(item => item.name === vpcItem.dhcpOptions);
      const vpcAccountNames = helpers.getVpcAccountNames(vpcItem);
      const targetComparison = optSet ? helpers.compareTargetAccounts(vpcAccountNames, optSet.accounts) : [];

      if (!optSet) {
        errors.push(`[VPC ${vpcItem.name}]: DHCP options set ${vpcItem.dhcpOptions} does not exist`);
      }
      // Validate DHCP options set exists in the same account and region
      if (optSet && targetComparison.length > 0) {
        errors.push(
          `[VPC ${vpcItem.name}]: DHCP options set "${vpcItem.dhcpOptions}" is not deployed to one or more VPC deployment target accounts. Missing accounts: ${targetComparison}`,
        );
      }
      if (optSet && !optSet.regions.includes(vpcItem.region)) {
        errors.push(
          `[VPC ${vpcItem.name}]: DHCP options set "${vpcItem.dhcpOptions}" is not deployed to VPC region ${vpcItem.region}`,
        );
      }
    }
  }

  /**
   * Validate DNS firewall rule groups
   * @param values
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateDnsFirewallRuleGroups(
    values: NetworkConfig,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    const groupNames: string[] = [];
    const priorities: string[] = [];
    vpcItem.dnsFirewallRuleGroups?.forEach(group => {
      groupNames.push(group.name);
      priorities.push(group.priority.toString());
    });

    // Validate there are no duplicates
    if (helpers.hasDuplicates(groupNames)) {
      errors.push(
        `[VPC ${vpcItem.name}]: duplicate DNS firewall rule groups defined. Rule groups must be unique. Rule groups configured: ${groupNames}`,
      );
    }
    if (helpers.hasDuplicates(priorities)) {
      errors.push(
        `[VPC ${vpcItem.name}]: duplicate DNS firewall rule group priorities defined. Priorities must be unique. Priorities configured: ${priorities}`,
      );
    }

    // Validate rule groups
    const vpcAccountNames = helpers.getVpcAccountNames(vpcItem);
    groupNames.forEach(name => {
      const group = values.centralNetworkServices?.route53Resolver?.firewallRuleGroups?.find(
        item => item.name === name,
      );
      if (!group) {
        errors.push(`[VPC ${vpcItem.name}]: DNS firewall rule group "${name}" does not exist`);
      } else {
        // Validate accounts and regions
        const groupAccountNames = helpers.getDelegatedAdminShareTargets(group.shareTargets);
        const targetComparison = helpers.compareTargetAccounts(vpcAccountNames, groupAccountNames);
        if (targetComparison.length > 0) {
          errors.push(
            `[VPC ${vpcItem.name}]: DNS firewall rule group "${name}" is not shared to one or more VPC deployment target accounts. Missing accounts: ${targetComparison}`,
          );
        }
        if (!group.regions.includes(vpcItem.region)) {
          errors.push(
            `[VPC ${vpcItem.name}]: DNS firewall rule group "${name}" is not deployed to VPC region ${vpcItem.region}`,
          );
        }
      }
    });
  }

  /**
   * Validate VPC endpoint policies
   * @param values
   * @param vpcItem
   * @param errors
   */
  private validateEndpointPolicies(values: NetworkConfig, vpcItem: VpcConfig | VpcTemplatesConfig, errors: string[]) {
    const policies = values.endpointPolicies.map(policy => {
      return policy.name;
    });
    const endpoints = [
      ...(vpcItem.gatewayEndpoints?.endpoints ?? []),
      ...(vpcItem.interfaceEndpoints?.endpoints ?? []),
    ];

    // Validate default policies
    if (vpcItem.gatewayEndpoints && !policies.includes(vpcItem.gatewayEndpoints.defaultPolicy)) {
      errors.push(
        `[VPC ${vpcItem.name}]: gateway endpoint defaultPolicy "${vpcItem.gatewayEndpoints.defaultPolicy}" does not exist`,
      );
    }
    if (vpcItem.interfaceEndpoints && !policies.includes(vpcItem.interfaceEndpoints.defaultPolicy)) {
      errors.push(
        `[VPC ${vpcItem.name}]: interface endpoint defaultPolicy "${vpcItem.interfaceEndpoints.defaultPolicy}" does not exist`,
      );
    }

    // Validate per-endpoint policies
    endpoints.forEach(endpoint => {
      if (endpoint.policy && !policies.includes(endpoint.policy)) {
        errors.push(
          `[VPC ${vpcItem.name}]: endpoint policy "${endpoint.policy}" for ${endpoint.service} endpoint does not exist`,
        );
      }
    });
  }

  /**
   * Validate gateway endpoints
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateGatewayEndpoints(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    const endpoints: string[] = [];
    vpcItem.gatewayEndpoints?.endpoints.forEach(endpoint => endpoints.push(endpoint.service));

    if (endpoints.length > 2) {
      errors.push(`[VPC ${vpcItem.name}]: no more than two gateway endpoints may be specified`);
    }

    if (helpers.hasDuplicates(endpoints)) {
      errors.push(
        `[VPC ${vpcItem.name}]: duplicate gateway endpoint services defined. Services must be unique. Services configured: ${endpoints}`,
      );
    }
  }

  /**
   * Validate interface endpoint configuration
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateInterfaceEndpoints(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    // Validate endpoint service names
    const services: string[] = [];
    vpcItem.interfaceEndpoints?.endpoints.forEach(endpoint => services.push(endpoint.service));
    if (helpers.hasDuplicates(services)) {
      errors.push(
        `[VPC ${vpcItem.name}]: interfaceEndpoints has duplicate service endpoints defined. Services must be unique. Services configured: ${services}`,
      );
    }

    // Validate allowed CIDRs
    vpcItem.interfaceEndpoints?.allowedCidrs?.forEach(cidr => {
      if (!helpers.isValidIpv4Cidr(cidr)) {
        errors.push(
          `[VPC ${vpcItem.name}]: interface endpoint allowed CIDR "${cidr}" is invalid. Value must be a valid IPv4 CIDR range`,
        );
      }
    });

    // Validate there are no duplicate subnet names
    if (vpcItem.interfaceEndpoints && helpers.hasDuplicates(vpcItem.interfaceEndpoints.subnets)) {
      errors.push(
        `[VPC ${vpcItem.name}]: interfaceEndpoints has duplicate target subnets defined. Subnets must be unique. Subnets configured: ${vpcItem.interfaceEndpoints.subnets}`,
      );
    }

    // Validate that tags are specified for the central endpoint VPC and not the spoke(s)
    if (vpcItem.interfaceEndpoints?.tags && !vpcItem.interfaceEndpoints.central) {
      errors.push(
        `[VPC ${vpcItem.name}]: has tags set under interfaceEndpoints to tag the Private Hosted Zones, but is not set to the central VPC for interface endpoints`,
      );
    }

    // Validate subnets
    const azs: (string | number)[] = [];
    vpcItem.interfaceEndpoints?.subnets.forEach(subnetName => {
      const subnet = helpers.getSubnet(vpcItem, subnetName);
      if (!subnet) {
        errors.push(`[VPC ${vpcItem.name}]: interfaceEndpoints target subnet "${subnetName}" does not exist in VPC`);
      } else {
        azs.push(subnet.availabilityZone ? subnet.availabilityZone : '');
      }
    });
    // Validate there are no duplicate AZs
    if (helpers.hasDuplicates(azs)) {
      errors.push(
        `[VPC ${vpcItem.name}]: interfaceEndpoints target subnets reside in duplicate AZs. AZs must be unique. AZs configured: ${azs}`,
      );
    }
  }

  /**
   * Validate NAT gateways for a given VPC
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateNatGateways(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    const natNames: string[] = [];
    vpcItem.natGateways?.forEach(nat => {
      natNames.push(nat.name);
      // Validate subnet exists
      if (!helpers.getSubnet(vpcItem, nat.subnet)) {
        errors.push(`[VPC ${vpcItem.name} NAT gateway ${nat.name}]: subnet "${nat.subnet}" does not exist in the VPC`);
      }
      // Validate connectivity type
      if (nat.private && nat.allocationId) {
        errors.push(
          `[VPC ${vpcItem.name} NAT gateway ${nat.name}]: cannot define an allocationId for a private NAT gateway`,
        );
      }
    });

    if (helpers.hasDuplicates(natNames)) {
      errors.push(
        `[VPC ${vpcItem.name}]: duplicate NAT gateway names defined. NAT gateway names must be unique. NAT gateway names configured: ${natNames}`,
      );
    }
  }

  /**
   * Validate NACLs for a given VPC
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateNacls(vpcItem: VpcConfig | VpcTemplatesConfig, helpers: NetworkValidatorFunctions, errors: string[]) {
    // Validate NACL names
    this.validateNaclNames(vpcItem, helpers, errors);
    // Validate NACL subnets
    this.validateNaclSubnets(vpcItem, helpers, errors);
    // Validate rule numbers
    this.validateNaclRuleNumbers(vpcItem, helpers, errors);
    // Validate ports
    this.validateNaclPorts(vpcItem, errors);
    // Validate NACL source/destination
    this.validateNaclSourceDestinationConfig(vpcItem, helpers, errors);
  }

  /**
   * Validate there are no duplicate NACL names
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateNaclNames(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    const naclNames: string[] = [];
    vpcItem.networkAcls?.forEach(nacl => naclNames.push(nacl.name));

    if (helpers.hasDuplicates(naclNames)) {
      errors.push(
        `[VPC ${vpcItem.name}]: duplicate NACL names defined. NACL names must be unique. NACL names configured: ${naclNames}`,
      );
    }
  }

  /**
   * Validate NACL subnet associations
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateNaclSubnets(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    const subnetNames: string[] = [];
    vpcItem.networkAcls?.forEach(nacl => {
      nacl.subnetAssociations.forEach(subnet => {
        subnetNames.push(subnet);
        // Validate subnet exists
        if (!helpers.getSubnet(vpcItem, subnet)) {
          errors.push(`[VPC ${vpcItem.name} NACL ${nacl.name}]: subnet "${subnet}" does not exist in the VPC`);
        }
      });
    });
    // Validate there are no duplicates
    if (helpers.hasDuplicates(subnetNames)) {
      errors.push(
        `[VPC ${vpcItem.name}]: duplicate NACL subnet associations defined. Subnet associations must be unique. Associations configured: ${subnetNames}`,
      );
    }
  }

  /**
   * Validate rule numbers for NACLs in a VPC
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateNaclRuleNumbers(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    vpcItem.networkAcls?.forEach(nacl => {
      const inboundIds: string[] = [];
      const outboundIds: string[] = [];
      // Validate inbound rules
      nacl.inboundRules?.forEach(inboundRule => {
        inboundIds.push(inboundRule.rule.toString());

        if (inboundRule.rule < 1 || inboundRule.rule > 32766) {
          errors.push(
            `[VPC ${vpcItem.name} NACL ${nacl.name}]: NACL inbound rule "${inboundRule.rule}" is invalid. Rule ID must be an integer in the range 1-32766`,
          );
        }
      });
      // Validate outbound rules
      nacl.outboundRules?.forEach(outboundRule => {
        outboundIds.push(outboundRule.rule.toString());

        if (outboundRule.rule < 1 || outboundRule.rule > 32766) {
          errors.push(
            `[VPC ${vpcItem.name} NACL ${nacl.name}]: NACL outbound rule "${outboundRule.rule}" is invalid. Rule ID must be an integer in the range 1-32766`,
          );
        }
      });

      // Validate duplicates
      if (helpers.hasDuplicates(inboundIds)) {
        errors.push(
          `[VPC ${vpcItem.name} NACL ${nacl.name}]: duplicate inbound rule IDs defined. Rule IDs must be unique. Rule IDs configured: ${inboundIds}`,
        );
      }
      if (helpers.hasDuplicates(outboundIds)) {
        errors.push(
          `[VPC ${vpcItem.name} NACL ${nacl.name}]: duplicate outbound rule IDs defined. Rule IDs must be unique. Rule IDs configured: ${outboundIds}`,
        );
      }
    });
  }

  /**
   * Validate ports defined in VPC NACLs
   * @param vpcItem
   * @param errors
   */
  private validateNaclPorts(vpcItem: VpcConfig | VpcTemplatesConfig, errors: string[]) {
    vpcItem.networkAcls?.forEach(nacl => {
      // Validate inbound ports
      nacl.inboundRules?.forEach(inbound => {
        const isAllPorts = inbound.fromPort === -1 && inbound.toPort === -1;
        const isValidPortRange = inbound.fromPort <= inbound.toPort;
        const portRangeString = `fromPort: ${inbound.fromPort}, toPort: ${inbound.toPort}`;
        if (!isValidPortRange) {
          errors.push(
            `[VPC ${vpcItem.name} NACL ${nacl.name} inbound rule ${inbound.rule}]: fromPort must be less than or equal to toPort. Defined port range: ${portRangeString}`,
          );
        } else {
          if (!isAllPorts && (inbound.fromPort < 0 || inbound.fromPort > 65535)) {
            errors.push(
              `[VPC ${vpcItem.name} NACL ${nacl.name} inbound rule ${inbound.rule}]: when not using -1, fromPort value must be between 0 and 65535. Defined port range: ${portRangeString}`,
            );
          }

          if (!isAllPorts && (inbound.toPort < 0 || inbound.toPort > 65535)) {
            errors.push(
              `[VPC ${vpcItem.name} NACL ${nacl.name} inbound rule ${inbound.rule}]: when not using -1, toPort value must be between 0 and 65535. Defined port range: ${portRangeString}`,
            );
          }
        }
      });
      // Validate outbound ports
      nacl.outboundRules?.forEach(outbound => {
        const isAllPorts = outbound.fromPort === -1 && outbound.toPort === -1;
        const isValidPortRange = outbound.fromPort <= outbound.toPort;
        const portRangeString = `fromPort: ${outbound.fromPort}, toPort: ${outbound.toPort}`;
        if (!isValidPortRange) {
          errors.push(
            `[VPC ${vpcItem.name} NACL ${nacl.name} outbound rule ${outbound.rule}]: fromPort must be less than or equal to toPort. Defined port range: ${portRangeString}`,
          );
        } else {
          if (!isAllPorts && (outbound.fromPort < 0 || outbound.fromPort > 65535)) {
            errors.push(
              `[VPC ${vpcItem.name} NACL ${nacl.name} outbound rule ${outbound.rule}]: when not using -1, fromPort value must be between 0 and 65535. Defined port range: ${portRangeString}`,
            );
          }

          if (!isAllPorts && (outbound.toPort < 0 || outbound.toPort > 65535)) {
            errors.push(
              `[VPC ${vpcItem.name} NACL ${nacl.name} outbound rule ${outbound.rule}]: when not using -1, toPort value must be between 0 and 65535. Defined port range: ${portRangeString}`,
            );
          }
        }
      });
    });
  }

  /**
   * Validate NACL rule source/destination configuration
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateNaclSourceDestinationConfig(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    // Validate NACL inbound CIDRs
    this.validateNaclCidrs(vpcItem, helpers, errors);
    // Validate NACL inbound subnet selection
    this.validateNaclInboundSubnetSelections(vpcItem, helpers, errors);
    // Validate NACL outbound subnet selection
    this.validateNaclOutboundSubnetSelections(vpcItem, helpers, errors);
  }

  /**
   * Validate NACL CIDR sources/destinations
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateNaclCidrs(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    vpcItem.networkAcls?.forEach(nacl => {
      // Validate inbound sources
      nacl.inboundRules?.forEach(inbound => {
        if (typeof inbound.source === 'string') {
          // Validate CIDR source
          if (!helpers.isValidIpv4Cidr(inbound.source) && !helpers.isValidIpv6Cidr(inbound.source)) {
            errors.push(
              `[VPC ${vpcItem.name} NACL ${nacl.name} inbound rule ${inbound.rule}]: source "${inbound.source}" is invalid. Source must be a valid IPv4/v6 CIDR or subnet selection`,
            );
          }
        }
      });
      // Validate outbound destinations
      nacl.outboundRules?.forEach(outbound => {
        if (typeof outbound.destination === 'string') {
          // Validate CIDR source
          if (!helpers.isValidIpv4Cidr(outbound.destination) && !helpers.isValidIpv6Cidr(outbound.destination)) {
            errors.push(
              `[VPC ${vpcItem.name} NACL ${nacl.name} outbound rule ${outbound.rule}]: destination "${outbound.destination}" is invalid. Destination must be a valid IPv4/v6 CIDR or subnet selection`,
            );
          }
        }
      });
    });
  }

  /**
   * Validate NACL inbound subnet selections
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateNaclInboundSubnetSelections(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    vpcItem.networkAcls?.forEach(nacl => {
      nacl.inboundRules?.forEach(inbound => {
        if (isNetworkType<NetworkAclSubnetSelection>('INetworkAclSubnetSelection', inbound.source)) {
          // Validate subnet source
          const vpc = helpers.getVpc(inbound.source.vpc);
          if (!vpc) {
            errors.push(
              `[VPC ${vpcItem.name} NACL ${nacl.name} inbound rule ${inbound.rule}]: source VPC "${inbound.source.vpc}" does not exist`,
            );
          } else {
            // Validate subnet
            if (!helpers.getSubnet(vpc, inbound.source.subnet)) {
              errors.push(
                `[VPC ${vpcItem.name} NACL ${nacl.name} inbound rule ${inbound.rule}]: subnet "${inbound.source.subnet}" does not exist in source VPC "${inbound.source.vpc}"`,
              );
            }
            // Validate account target
            const vpcAccountNames = helpers.getVpcAccountNames(vpc);
            if (!vpcAccountNames.includes(inbound.source.account)) {
              errors.push(
                `[VPC ${vpcItem.name} NACL ${nacl.name} inbound rule ${inbound.rule}]: source VPC "${inbound.source.vpc}" is not deployed to account "${inbound.source.account}"`,
              );
            }
            // Validate VPC region
            if (inbound.source.region && inbound.source.region !== vpc.region) {
              errors.push(
                `[VPC ${vpcItem.name} NACL ${nacl.name} inbound rule ${inbound.rule}]: source VPC "${inbound.source.vpc}" does not exist in region "${inbound.source.region}"`,
              );
            }
            if (!inbound.source.region && vpcItem.region !== vpc.region) {
              errors.push(
                `[VPC ${vpcItem.name} NACL ${nacl.name} inbound rule ${inbound.rule}]: source VPC "${inbound.source.vpc}" does not exist in VPC region "${vpcItem.region}." Use region property for subnet selection if targeting a source VPC in a different region`,
              );
            }
          }
        }
      });
    });
  }

  /**
   * Validate NACL outbound subnet selections
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateNaclOutboundSubnetSelections(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    vpcItem.networkAcls?.forEach(nacl => {
      nacl.outboundRules?.forEach(outbound => {
        if (isNetworkType<NetworkAclSubnetSelection>('INetworkAclSubnetSelection', outbound.destination)) {
          // Validate subnet source
          const vpc = helpers.getVpc(outbound.destination.vpc);
          if (!vpc) {
            errors.push(
              `[VPC ${vpcItem.name} NACL ${nacl.name} outbound rule ${outbound.rule}]: destination VPC "${outbound.destination.vpc}" does not exist`,
            );
          } else {
            // Validate subnet
            if (!helpers.getSubnet(vpc, outbound.destination.subnet)) {
              errors.push(
                `[VPC ${vpcItem.name} NACL ${nacl.name} outbound rule ${outbound.rule}]: subnet "${outbound.destination.subnet}" does not exist in destination VPC "${outbound.destination.vpc}"`,
              );
            }
            // Validate account target
            const vpcAccountNames = helpers.getVpcAccountNames(vpc);
            if (!vpcAccountNames.includes(outbound.destination.account)) {
              errors.push(
                `[VPC ${vpcItem.name} NACL ${nacl.name} outbound rule ${outbound.rule}]: destination VPC "${outbound.destination.vpc}" is not deployed to account "${outbound.destination.account}"`,
              );
            }
            // Validate VPC region
            if (outbound.destination.region && outbound.destination.region !== vpc.region) {
              errors.push(
                `[VPC ${vpcItem.name} NACL ${nacl.name} outbound rule ${outbound.rule}]: destination VPC "${outbound.destination.vpc}" does not exist in region "${outbound.destination.region}"`,
              );
            }
            if (!outbound.destination.region && vpcItem.region !== vpc.region) {
              errors.push(
                `[VPC ${vpcItem.name} NACL ${nacl.name} outbound rule ${outbound.rule}]: destination VPC "${outbound.destination.vpc}" does not exist in VPC region "${vpcItem.region}." Use region property for subnet selection if targeting a destination VPC in a different region`,
              );
            }
          }
        }
      });
    });
  }

  /**
   * Validate DNS query logs
   * @param values
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateQueryLogs(
    values: NetworkConfig,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    // Validate query log name
    const queryLogs = values.centralNetworkServices?.route53Resolver?.queryLogs;
    vpcItem.queryLogs?.forEach(name => {
      if (!queryLogs) {
        errors.push(`[VPC ${vpcItem.name}]: DNS query logs "${name}" does not exist`);
      } else {
        if (name !== queryLogs.name) {
          errors.push(`[VPC ${vpcItem.name}]: DNS query logs "${name}" does not exist`);
        }

        // Validate query log share targets
        const vpcAccountNames = helpers.getVpcAccountNames(vpcItem);
        const queryLogAccountNames = helpers.getDelegatedAdminShareTargets(queryLogs.shareTargets);
        const targetComparison = helpers.compareTargetAccounts(vpcAccountNames, queryLogAccountNames);
        if (targetComparison.length > 0) {
          errors.push(
            `[VPC ${vpcItem.name}]: DNS query logging configuration "${name}" is not shared to one or more VPC deployment target accounts. Missing accounts: ${targetComparison}`,
          );
        }
      }
    });
  }

  /**
   * Validate resolver rules
   * @param values
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateResolverRules(
    values: NetworkConfig,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    // Fetch resolver rules
    const resolverRules: ResolverRuleConfig[] = [];
    values.centralNetworkServices?.route53Resolver?.rules?.forEach(systemRule => resolverRules.push(systemRule));
    values.centralNetworkServices?.route53Resolver?.endpoints?.forEach(endpoint => {
      endpoint.rules?.forEach(forwardRule => resolverRules.push(forwardRule));
    });

    // Validate rule
    vpcItem.resolverRules?.forEach(name => {
      const rule = resolverRules.find(item => name === item.name);
      if (!rule) {
        errors.push(`[VPC ${vpcItem.name}]: Resolver rule "${name}" does not exist`);
      } else {
        // Validate target accounts
        const vpcAccountNames = helpers.getVpcAccountNames(vpcItem);
        const ruleAccountNames = helpers.getDelegatedAdminShareTargets(rule.shareTargets);
        const resolverEndpoint = values.centralNetworkServices?.route53Resolver?.endpoints?.find(endpointItem =>
          endpointItem.rules?.find(ruleItem => rule.name === ruleItem.name),
        );
        const targetComparison = helpers.compareTargetAccounts(vpcAccountNames, ruleAccountNames);

        if (targetComparison.length > 0) {
          errors.push(
            `[VPC ${vpcItem.name}]: Resolver rule "${name}" is not shared to one or more VPC deployment target accounts. Missing accounts: ${targetComparison}`,
          );
        }
        // Validate target region
        if (rule.excludedRegions && rule.excludedRegions.includes(vpcItem.region)) {
          errors.push(`[VPC ${vpcItem.name}]: Resolver rule "${name}" is not deployed to VPC region ${vpcItem.region}`);
        }
        if (resolverEndpoint) {
          const resolverEndpointVpc = helpers.getVpc(resolverEndpoint.vpc);
          if (resolverEndpointVpc && resolverEndpointVpc.region !== vpcItem.region) {
            errors.push(
              `[VPC ${vpcItem.name}]: Resolver rule "${name}" is not deployed to VPC region ${vpcItem.region}`,
            );
          }
        }
      }
    });
  }

  /**
   * Validate security group sources
   * @param values
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateSecurityGroups(
    values: NetworkConfig,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    // Validate group names
    this.validateSecurityGroupNames(vpcItem, helpers, errors);
    // Validate group structure
    const ingressValid = this.validateSecurityGroupIngressStructure(vpcItem, helpers, errors);
    const egressValid = this.validateSecurityGroupEgressStructure(vpcItem, helpers, errors);

    if (ingressValid && egressValid) {
      // Validate security group sources
      this.validateSecurityGroupSources(values, vpcItem, helpers, errors);
      // Validate security group ports
      this.validateSecurityGroupPorts(vpcItem, errors);
    }
  }

  /**
   * Validate security group names
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateSecurityGroupNames(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    const groupNames: string[] = [];
    vpcItem.securityGroups?.forEach(group => groupNames.push(group.name));
    if (helpers.hasDuplicates(groupNames)) {
      errors.push(
        `[VPC ${vpcItem.name}]: duplicate security group names defined. Security group names must be unique. Security group names configured: ${groupNames}`,
      );
    }
  }

  /**
   * Returns true if all inbound rules have the correct structure
   * @param vpcItem
   * @param helpers
   * @param errors
   * @returns
   */
  private validateSecurityGroupIngressStructure(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ): boolean {
    const toFromPorts = ['fromPort', 'toPort'];
    const tcpUdpPorts = ['tcpPorts', 'udpPorts'];
    let allValid = true;

    vpcItem.securityGroups?.forEach(group => {
      group.inboundRules.forEach(inbound => {
        const keys = helpers.getObjectKeys(inbound);
        if (inbound.types) {
          allValid = this.securityGroupValidateTypes(group, inbound, keys, vpcItem, errors);
        } else {
          // Validate to/fromPorts don't exist
          if (toFromPorts.some(item => keys.includes(item))) {
            allValid = false;
            errors.push(
              `[VPC ${vpcItem.name} security group ${group.name}]: inboundRules cannot contain ${toFromPorts} properties when types property is undefined`,
            );
          }
          // Validate tcpPorts/udpPorts exists
          if (!inbound.tcpPorts && !inbound.udpPorts && !inbound.ipProtocols) {
            allValid = false;
            errors.push(
              `[VPC ${vpcItem.name} security group ${group.name}]: inboundRules must contain one of ${tcpUdpPorts} properties when both the types and ipProtocols properties are undefined.`,
            );
          }
        }
        if (inbound.ipProtocols) {
          allValid = this.securityGroupValidateIpProtocols(group, inbound, vpcItem, errors);
        }
      });
    });
    return allValid;
  }

  /**
   * Returns true if all inbound rules have the correct structure
   * @param vpcItem
   * @param helpers
   * @param errors
   * @returns
   */
  private validateSecurityGroupEgressStructure(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ): boolean {
    const toFromPorts = ['fromPort', 'toPort'];
    const tcpUdpPorts = ['tcpPorts', 'udpPorts'];
    let allValid = true;

    vpcItem.securityGroups?.forEach(group => {
      group.outboundRules.forEach(outbound => {
        const keys = helpers.getObjectKeys(outbound);
        if (outbound.types) {
          allValid = this.securityGroupValidateTypes(group, outbound, keys, vpcItem, errors);
        } else {
          // Validate to/fromPorts don't exist
          if (toFromPorts.some(item => keys.includes(item))) {
            allValid = false;
            errors.push(
              `[VPC ${vpcItem.name} security group ${group.name}]: outboundRules cannot contain ${toFromPorts} properties when types property is undefined`,
            );
          }
          // Validate tcpPorts/udpPorts exists
          if (!outbound.tcpPorts && !outbound.udpPorts && !outbound.ipProtocols) {
            allValid = false;
            errors.push(
              `[VPC ${vpcItem.name} security group ${group.name}]: outboundRules must contain one of ${tcpUdpPorts} properties when both the types and ipProtocols properties are undefined.`,
            );
          }
        }
        if (outbound.ipProtocols) {
          allValid = this.securityGroupValidateIpProtocols(group, outbound, vpcItem, errors);
        }
      });
    });
    return allValid;
  }

  /**
   * Validate security group types
   * @param securityGroupItem
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private securityGroupValidateTypes(
    group: SecurityGroupConfig,
    securityGroupItem: SecurityGroupRuleConfig,
    keys: string[],
    vpcItem: VpcConfig | VpcTemplatesConfig,
    errors: string[],
  ): boolean {
    let allValid = true;
    const toFromPorts = ['fromPort', 'toPort'];
    const tcpUdpPorts = ['tcpPorts', 'udpPorts'];
    const toFromTypes = ['ICMP', 'TCP', 'UDP'];
    const tcpUdpTypes = ['TCP', 'UDP'];

    // Validate types and tcpPorts/udpPorts are not defined in the same rule
    if (keys.some(key => tcpUdpPorts.includes(key))) {
      allValid = false;
      errors.push(
        `[VPC ${vpcItem.name} security group ${group.name}]: Rules cannot contain ${tcpUdpPorts} properties when types property is defined`,
      );
    }
    // Validate type is correct if using fromPort/toPort
    if (
      securityGroupItem.types!.some(type => toFromTypes.includes(type)) &&
      toFromPorts.some(item => !keys.includes(item))
    ) {
      allValid = false;
      errors.push(
        `[VPC ${vpcItem.name} security group ${group.name}]: Rules must contain ${toFromPorts} properties when one of the following types is specified: ${toFromTypes}`,
      );
    }
    if (
      securityGroupItem.types!.some(type => !toFromTypes.includes(type)) &&
      toFromPorts.some(item => keys.includes(item))
    ) {
      allValid = false;
      errors.push(
        `[VPC ${vpcItem.name} security group ${group.name}]: Rules may only contain ${toFromPorts} properties when one of the following types is specified: ${toFromTypes}`,
      );
    }
    // Validate both TCP/UDP and ICMP are not used in the same rule
    if (
      securityGroupItem.types!.some(type => tcpUdpTypes.includes(type)) &&
      securityGroupItem.types!.includes('ICMP')
    ) {
      allValid = false;
      errors.push(
        `[VPC ${vpcItem.name} security group ${group.name}]: Rules cannot contain both ICMP and TCP/UDP types in the same rule`,
      );
    }
    if (securityGroupItem.ipProtocols) {
      allValid = false;
      errors.push(
        `[VPC ${vpcItem.name} security group ${group.name}]: Rules cannot contain both types and ipProtocols for the same rule. Create separate rules for both.`,
      );
    }
    return allValid;
  }

  /**
   * Validate security group ip protocols
   * @param securityGroupItem
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private securityGroupValidateIpProtocols(
    group: SecurityGroupConfig,
    securityGroupItem: SecurityGroupRuleConfig,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    errors: string[],
  ): boolean {
    let allValid = true;
    const invalidProtocols: string[] = [];
    for (const ipProtocolItem of securityGroupItem.ipProtocols ?? []) {
      const protocolExists = ipProtocolItem in cdk.aws_ec2.Protocol;
      if (!protocolExists) {
        if (!invalidProtocols.includes(ipProtocolItem)) {
          invalidProtocols.push(ipProtocolItem);
        }
      }
    }
    if (invalidProtocols.length > 0) {
      allValid = false;
      errors.push(
        `[VPC ${vpcItem.name} security group ${
          group.name
        }]: Is using the following unsupported IP Protocols: [${invalidProtocols.join(', ')}]`,
      );
    }
    return allValid;
  }

  /**
   * Validate security group sources
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateSecurityGroupSources(
    values: NetworkConfig,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    // Validate CIDR sources
    this.validateSecurityGroupCidrs(vpcItem, helpers, errors);
    // Validate subnet sources
    this.validateSecurityGroupIngressSubnetSources(vpcItem, helpers, errors);
    this.validateSecurityGroupEgressSubnetSources(vpcItem, helpers, errors);
    // Validate SG sources
    this.validateSecurityGroupSgSources(vpcItem, errors);
    // Validate prefix list sources
    this.validateSecurityGroupPrefixListSources(values, vpcItem, helpers, errors);
  }

  /**
   * Validate security group source CIDRs
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateSecurityGroupCidrs(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    vpcItem.securityGroups?.forEach(group => {
      group.inboundRules.forEach(inbound => {
        // Validate inbound sources
        inbound.sources.forEach(inboundSource => {
          if (typeof inboundSource === 'string') {
            if (!helpers.isValidIpv4Cidr(inboundSource) && !helpers.isValidIpv6Cidr(inboundSource)) {
              errors.push(
                `[VPC ${vpcItem.name} security group ${group.name}]: inbound rule source "${inboundSource}" is invalid. Value must be a valid IPv4/v6 CIDR, subnet reference, security group reference, or prefix list reference`,
              );
            }
          }
        });
      });
      // Validate outbound sources
      group.outboundRules.forEach(outbound => {
        outbound.sources.forEach(outboundSource => {
          if (typeof outboundSource === 'string') {
            if (!helpers.isValidIpv4Cidr(outboundSource) && !helpers.isValidIpv6Cidr(outboundSource)) {
              errors.push(
                `[VPC ${vpcItem.name} security group ${group.name}]: outbound rule source "${outboundSource}" is invalid. Value must be a valid IPv4/v6 CIDR, subnet reference, security group reference, or prefix list reference`,
              );
            }
          }
        });
      });
    });
  }

  /**
   * Validate security group ingress subnet sources
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateSecurityGroupIngressSubnetSources(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    vpcItem.securityGroups?.forEach(group => {
      group.inboundRules.forEach(inbound => {
        inbound.sources.forEach(source => {
          if (isNetworkType<SubnetSourceConfig>('ISubnetSourceConfig', source)) {
            // Validate subnet source
            const vpc = helpers.getVpc(source.vpc);
            if (!vpc) {
              errors.push(
                `[VPC ${vpcItem.name} security group ${group.name}]: inboundRule source VPC "${source.vpc}" does not exist`,
              );
            } else {
              // Validate subnets
              source.subnets.forEach(subnet => {
                const subnetItem = helpers.getSubnet(vpc, subnet);
                if (!subnetItem) {
                  errors.push(
                    `[VPC ${vpcItem.name} security group ${group.name}]: subnet "${subnet}" does not exist in source VPC "${source.vpc}"`,
                  );
                } else {
                  // Check cross-account IPAM subnet condition
                  const sourceVpcAccountNames = helpers.getVpcAccountNames(vpcItem);
                  if (
                    (!sourceVpcAccountNames.includes(source.account) || vpc.region !== vpcItem.region) &&
                    subnetItem.ipamAllocation
                  ) {
                    errors.push(
                      `[VPC ${vpcItem.name} security group ${group.name}]: accelerator does not currently support cross-account/cross-region IPAM subnets as security group references (source VPC: ${source.vpc}, source subnet: ${subnet}, source account: ${source.account})`,
                    );
                  }
                }
              });

              // Validate account target
              const vpcAccountNames = helpers.getVpcAccountNames(vpc);
              if (!vpcAccountNames.includes(source.account)) {
                errors.push(
                  `[VPC ${vpcItem.name} security group ${group.name}]: source VPC "${source.vpc}" is not deployed to account "${source.account}"`,
                );
              }
            }
          }
        });
      });
    });
  }

  /**
   * Validate security group ingress subnet sources
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateSecurityGroupEgressSubnetSources(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    vpcItem.securityGroups?.forEach(group => {
      group.outboundRules.forEach(outbound => {
        outbound.sources.forEach(source => {
          if (isNetworkType<SubnetSourceConfig>('ISubnetSourceConfig', source)) {
            // Validate subnet source
            const vpc = helpers.getVpc(source.vpc);
            if (!vpc) {
              errors.push(
                `[VPC ${vpcItem.name} security group ${group.name}]: outboundRule source VPC "${source.vpc}" does not exist`,
              );
            } else {
              // Validate subnets
              source.subnets.forEach(subnet => {
                const subnetItem = helpers.getSubnet(vpc, subnet);
                if (!subnetItem) {
                  errors.push(
                    `[VPC ${vpcItem.name} security group ${group.name}]: subnet "${subnet}" does not exist in source VPC "${source.vpc}"`,
                  );
                } else {
                  // Check cross-account IPAM subnet condition
                  const sourceVpcAccountNames = helpers.getVpcAccountNames(vpcItem);
                  if (
                    (!sourceVpcAccountNames.includes(source.account) || vpc.region !== vpcItem.region) &&
                    subnetItem.ipamAllocation
                  ) {
                    errors.push(
                      `[VPC ${vpcItem.name} security group ${group.name}]: accelerator does not currently support cross-account/cross-region IPAM subnets as security group references (source VPC: ${source.vpc}, source subnet: ${subnet}, source account: ${source.account})`,
                    );
                  }
                }
              });

              // Validate account target
              const vpcAccountNames = helpers.getVpcAccountNames(vpc);
              if (!vpcAccountNames.includes(source.account)) {
                errors.push(
                  `[VPC ${vpcItem.name} security group ${group.name}]: source VPC "${source.vpc}" is not deployed to account "${source.account}"`,
                );
              }
            }
          }
        });
      });
    });
  }

  /**
   * Validate security group sourcing another security group
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateSecurityGroupSgSources(vpcItem: VpcConfig | VpcTemplatesConfig, errors: string[]) {
    const securityGroups: string[] = [];
    vpcItem.securityGroups?.forEach(groupItem => securityGroups.push(groupItem.name));

    vpcItem.securityGroups?.forEach(group => {
      group.inboundRules.forEach(inbound => {
        // Validate inbound sources
        inbound.sources.forEach(inboundSource => {
          if (isNetworkType<SecurityGroupSourceConfig>('ISecurityGroupSourceConfig', inboundSource)) {
            inboundSource.securityGroups.forEach(sg => {
              if (!securityGroups.includes(sg)) {
                errors.push(
                  `[VPC ${vpcItem.name} security group ${group.name}]: inboundRule source security group "${sg}" does not exist in VPC`,
                );
              }
            });
          }
        });
      });
      // Validate outbound sources
      group.outboundRules.forEach(outbound => {
        outbound.sources.forEach(outboundSource => {
          if (isNetworkType<SecurityGroupSourceConfig>('ISecurityGroupSourceConfig', outboundSource)) {
            outboundSource.securityGroups.forEach(item => {
              if (!securityGroups.includes(item)) {
                errors.push(
                  `[VPC ${vpcItem.name} security group ${group.name}]: outboundRule source security group "${item}" does not exist in VPC`,
                );
              }
            });
          }
        });
      });
    });
  }

  /**
   * Validate prefix list sources
   * @param values
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateSecurityGroupPrefixListSources(
    values: NetworkConfig,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    // Get accounts for RAM shared subnets
    const sharedAccounts = vpcItem.subnets ? this.getSharedSubnetAccounts(vpcItem.subnets, helpers) : [];

    vpcItem.securityGroups?.forEach(group => {
      group.inboundRules.forEach(inbound => {
        // Validate inbound rules
        inbound.sources.forEach(inboundSource => {
          if (isNetworkType<PrefixListSourceConfig>('IPrefixListSourceConfig', inboundSource)) {
            inboundSource.prefixLists.forEach(listName => {
              const prefixList = values.prefixLists?.find(item => item.name === listName);
              if (!prefixList) {
                errors.push(
                  `[VPC ${vpcItem.name} security group ${group.name}]: inboundRule source prefix list "${listName}" does not exist`,
                );
                return;
              }
              if (prefixList.accounts || prefixList.deploymentTargets) {
                // Prefix lists must be deployed to all deployment target accounts, including subnet shares
                const accounts = [];
                if (prefixList.accounts && prefixList.accounts.length > 0) {
                  accounts.push(...prefixList.accounts);
                }
                if (prefixList.deploymentTargets) {
                  accounts.push(...helpers.getAccountNamesFromTarget(prefixList.deploymentTargets));
                }
                const vpcAccountNames = [...new Set([...helpers.getVpcAccountNames(vpcItem), ...sharedAccounts])];
                const targetComparison = helpers.compareTargetAccounts(vpcAccountNames, accounts);
                if (targetComparison.length > 0) {
                  errors.push(
                    `[VPC ${vpcItem.name} security group ${group.name}]: inboundRule source prefix list "${listName}" is not deployed to one or more VPC deployment target or subnet share target accounts. Missing accounts: ${targetComparison}`,
                  );
                }
              }
            });
          }
        });
      });
      // Validate outbound rules
      group.outboundRules.forEach(outbound => {
        outbound.sources.forEach(outboundSource => {
          if (isNetworkType<PrefixListSourceConfig>('IPrefixListSourceConfig', outboundSource)) {
            outboundSource.prefixLists.forEach(listName => {
              const prefixList = values.prefixLists?.find(item => item.name === listName);
              if (!prefixList) {
                errors.push(
                  `[VPC ${vpcItem.name} security group ${group.name}]: outboundRule source prefix list "${listName}" does not exist`,
                );
                return;
              }

              if (prefixList.accounts || prefixList.deploymentTargets) {
                // Prefix lists must be deployed to all deployment target accounts, including subnet shares
                const accounts = [];
                if (prefixList.accounts && prefixList.accounts.length > 0) {
                  accounts.push(...prefixList.accounts);
                }

                if (prefixList.deploymentTargets) {
                  accounts.push(...helpers.getAccountNamesFromTarget(prefixList.deploymentTargets));
                }
                const vpcAccountNames = [...new Set([...helpers.getVpcAccountNames(vpcItem), ...sharedAccounts])];
                const targetComparison = helpers.compareTargetAccounts(vpcAccountNames, accounts);
                if (targetComparison.length > 0) {
                  errors.push(
                    `[VPC ${vpcItem.name} security group ${group.name}]: outboundRule source prefix list "${listName}" is not deployed to one or more VPC deployment target or subnet share target accounts. Missing accounts: ${targetComparison}`,
                  );
                }
              }
            });
          }
        });
      });
    });
  }

  /**
   * Retrieve shared account names for a subnet's share targets
   * @param subnetConfig
   * @param helpers
   * @returns
   */
  private getSharedSubnetAccounts(subnetConfig: SubnetConfig[], helpers: NetworkValidatorFunctions): string[] {
    const sharedAccounts: string[] = [];

    for (const subnet of subnetConfig) {
      const subnetSharedAccounts = subnet.shareTargets ? helpers.getAccountNamesFromTarget(subnet.shareTargets) : [];
      sharedAccounts.push(...subnetSharedAccounts);
    }
    return [...new Set(sharedAccounts)];
  }

  /**
   * Validate security group ports
   * @param vpcItem
   * @param errors
   */
  private validateSecurityGroupPorts(vpcItem: VpcConfig | VpcTemplatesConfig, errors: string[]) {
    const tcpUdpTypes = ['TCP', 'UDP'];

    vpcItem.securityGroups?.forEach(group => {
      // Validate inbound rules
      group.inboundRules.forEach(inbound => {
        // Validate TCP/UDP ports
        if (inbound.types && inbound.types.some(inboundType => tcpUdpTypes.includes(inboundType))) {
          this.validateSecurityGroupTcpUdpPorts(vpcItem, group, inbound, 'inbound', errors);
        }
        // Validate ICMP codes
        if (inbound.types && inbound.types.includes('ICMP')) {
          this.validateSecurityGroupIcmp(vpcItem, group, inbound, 'inbound', errors);
        }
      });
      // Validate outbound rules
      group.outboundRules.forEach(outbound => {
        // Validate TCP/UDP ports
        if (outbound.types && outbound.types.some(outboundType => tcpUdpTypes.includes(outboundType))) {
          this.validateSecurityGroupTcpUdpPorts(vpcItem, group, outbound, 'outbound', errors);
        }
        // Validate ICMP codes
        if (outbound.types && outbound.types.includes('ICMP')) {
          this.validateSecurityGroupIcmp(vpcItem, group, outbound, 'outbound', errors);
        }
      });
    });
  }

  /**
   * Validate security group TCP/UDP ports
   * @param vpcItem
   * @param group
   * @param rule
   * @param direction
   * @param errors
   */
  private validateSecurityGroupTcpUdpPorts(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    group: SecurityGroupConfig,
    rule: SecurityGroupRuleConfig,
    direction: string,
    errors: string[],
  ) {
    if (rule.fromPort !== undefined && rule.toPort !== undefined) {
      const isValidPortRange = rule.fromPort <= rule.toPort;
      const portRangeString = `fromPort: ${rule.fromPort}, toPort: ${rule.toPort}`;

      if (!isValidPortRange) {
        errors.push(
          `[VPC ${vpcItem.name} security group ${group.name}]: ${direction} fromPort must be less than or equal to toPort. Defined port range: ${portRangeString}`,
        );
      }

      if (isValidPortRange && (rule.fromPort < 0 || rule.fromPort > 65535)) {
        errors.push(
          `[VPC ${vpcItem.name} security group ${group.name}]: ${direction} fromPort value must be between 0 and 65535. Defined port range: ${portRangeString}`,
        );
      }

      if (isValidPortRange && (rule.toPort < 0 || rule.toPort > 65535)) {
        errors.push(
          `[VPC ${vpcItem.name} security group ${group.name}]: ${direction} toPort value must be between 0 and 65535. Defined port range: ${portRangeString}`,
        );
      }
    }
  }

  /**
   * Validate security group ICMP codes
   * @param vpcItem
   * @param group
   * @param rule
   * @param direction
   * @param errors
   */
  private validateSecurityGroupIcmp(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    group: SecurityGroupConfig,
    rule: SecurityGroupRuleConfig,
    direction: string,
    errors: string[],
  ) {
    if (rule.fromPort !== undefined && rule.toPort !== undefined) {
      if (rule.fromPort === -1) {
        if (rule.toPort !== -1) {
          errors.push(
            `[VPC ${vpcItem.name} security group ${group.name}]: ${direction} ICMP rules using -1 as fromPort must also have -1 as toPort`,
          );
        }
      } else {
        if (rule.fromPort < 0 || rule.fromPort > 43) {
          errors.push(
            `[VPC ${vpcItem.name} security group ${group.name}]: if not allowing all ${direction} ICMP types (-1), fromPort must be in range 0-43`,
          );
        }
        if (rule.toPort !== -1 && (rule.toPort < 0 || rule.toPort > 15)) {
          errors.push(
            `[VPC ${vpcItem.name} security group ${group.name}]: if not allowing all ${direction} ICMP codes (-1), toPort must be in range 0-15`,
          );
        }
      }
    }
  }

  /**
   * Validate subnets for a given VPC
   * @param values
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateSubnets(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    // Validate subnet names
    this.validateSubnetNames(vpcItem, helpers, errors);
    // Validate subnet structure
    this.validateSubnetStructure(vpcItem, errors);
    // Validate subnet CIDR
    this.validateSubnetCidrs(vpcItem, helpers, errors);
    // Validate subnet route table
    this.validateSubnetRouteTables(vpcItem, errors);
    // Validate subnet availability zones
    this.validateSubnetAvailabilityZones(vpcItem, helpers, errors);
    // Validate subnets exist in VPC that are used with Application Load Balancer
    this.validateAlbConfigForExistingSubnets(vpcItem, helpers, errors);
    // Validate that Application Load Balancer that is using shared targets is using subnets that are using shared target.
    this.validateSharedAlbSubnets(vpcItem, helpers, errors);
    // Validate subnet share target ou names
    this.validateVpcSubnetShareTargetOUs(vpcItem, helpers, errors);
    // Validate subnet share target account names
    this.validateVpcSubnetShareTargetAccounts(vpcItem, helpers, errors);
  }

  /**
   * Validate subnet names
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateSubnetNames(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    const subnetNames: string[] = [];
    vpcItem.subnets?.forEach(subnet => subnetNames.push(subnet.name));
    if (helpers.hasDuplicates(subnetNames)) {
      errors.push(
        `[VPC ${vpcItem.name}]: duplicate subnet names defined. Subnet names must be unique. Subnet names in configuration: ${subnetNames}`,
      );
    }
  }

  /**
   * Validate subnet structure
   * @param vpcItem
   * @param errors
   */
  private validateSubnetStructure(vpcItem: VpcConfig | VpcTemplatesConfig, errors: string[]) {
    vpcItem.subnets?.forEach(subnet => {
      // Validate a CIDR or IPAM allocation is defined
      if (subnet.ipv4CidrBlock && subnet.ipamAllocation) {
        errors.push(
          `[VPC ${vpcItem.name} subnet ${subnet.name}]: cannot define both ipv4CidrBlock and ipamAllocation properties`,
        );
      }
      if (!subnet.ipv6CidrBlock && !subnet.ipv4CidrBlock && !subnet.ipamAllocation) {
        errors.push(
          `[VPC ${vpcItem.name} subnet ${subnet.name}]: must define one of ipv4CidrBlock, ipv6CidrBlock, or ipamAllocation properties`,
        );
      }
      // Validate IPv6 structure
      if (subnet.ipv6CidrBlock && subnet.ipv4CidrBlock && subnet.ipamAllocation) {
        errors.push(
          `[VPC ${vpcItem.name} subnet ${subnet.name}]: ipv4CidrBlock, ipv6CidrBlock, and ipamAllocation properties are all defined. A subnet may only have a maximum of one IPv4 and one IPv6 address.`,
        );
      }
      // Validate an AZ is assigned
      if (
        (subnet.availabilityZone && subnet.outpost) ||
        (subnet.availabilityZone && subnet.localZone) ||
        (subnet.localZone && subnet.outpost)
      ) {
        errors.push(
          `[VPC ${vpcItem.name} subnet ${subnet.name}]: can only define one of availabilityZone, localZone or outpost properties`,
        );
      }
      if (!subnet.availabilityZone && !subnet.outpost && !subnet.localZone) {
        errors.push(
          `[VPC ${vpcItem.name} subnet ${subnet.name}]: must define either availabilityZone, localZone or outpost property`,
        );
      }
    });
  }

  /**
   * Validate subnet CIDR
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateSubnetCidrs(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    vpcItem.subnets?.forEach(subnet => {
      // Validate IPv4 subnets
      if (subnet.ipv4CidrBlock) {
        if (!helpers.isValidIpv4Cidr(subnet.ipv4CidrBlock)) {
          errors.push(
            `[VPC ${vpcItem.name} subnet ${subnet.name}]: CIDR "${subnet.ipv4CidrBlock}" is invalid. Value must be a valid IPv4 CIDR range`,
          );
        }
        // Validate prefix
        const prefix = helpers.isValidIpv4Cidr(subnet.ipv4CidrBlock) ? subnet.ipv4CidrBlock.split('/')[1] : undefined;
        if (prefix && !this.isValidIpv4PrefixLength(parseInt(prefix))) {
          errors.push(
            `[VPC ${vpcItem.name} subnet ${subnet.name}]: CIDR "${subnet.ipv4CidrBlock}" is invalid. CIDR prefix cannot be larger than /16 or smaller than /28`,
          );
        }
      }
      // Validate IPv6 subnets
      if (subnet.ipv6CidrBlock) {
        if (!helpers.isValidIpv6Cidr(subnet.ipv6CidrBlock)) {
          errors.push(
            `[VPC ${vpcItem.name} subnet ${subnet.name}]: CIDR "${subnet.ipv6CidrBlock}" is invalid. Value must be a valid IPv6 CIDR range`,
          );
        }
        // Validate prefix
        const prefix = helpers.isValidIpv6Cidr(subnet.ipv6CidrBlock) ? subnet.ipv6CidrBlock.split('/')[1] : undefined;
        if (prefix && !this.isValidIpv6SubnetPrefixLength(parseInt(prefix))) {
          errors.push(
            `[VPC ${vpcItem.name} subnet ${subnet.name}]: CIDR "${subnet.ipv6CidrBlock}" is invalid. CIDR prefix cannot be larger than /44 or smaller than /64 and must be an increment of /4`,
          );
        }
      }
    });
  }

  /**
   * Validate subnet route table associations
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateSubnetRouteTables(vpcItem: VpcConfig | VpcTemplatesConfig, errors: string[]) {
    const tableNames: string[] = [];
    vpcItem.routeTables?.forEach(routeTable => tableNames.push(routeTable.name));

    vpcItem.subnets?.forEach(subnet => {
      if (subnet.routeTable && !tableNames.includes(subnet.routeTable)) {
        errors.push(
          `[VPC ${vpcItem.name} subnet ${subnet.name}]: route table "${subnet.routeTable}" does not exist in the VPC`,
        );
      }
    });
  }

  /**
   * Validate subnet availability zones
   * @param vpcItem
   * @param helps
   * @param errors
   */
  private validateSubnetAvailabilityZones(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    vpcItem.subnets?.forEach(subnet => {
      if (typeof subnet.availabilityZone === 'string') {
        if (!helpers.matchesRegex(subnet.availabilityZone, '^[a-z]{1}$')) {
          errors.push(
            `[VPC ${vpcItem.name} subnet ${subnet.name}]: Uses an incorrect value for ${subnet.availabilityZone} as the availabilityZone. Please use a single lowercase letter.`,
          );
        }
      }
      if (typeof subnet.availabilityZone === 'number') {
        if (!helpers.matchesRegex(subnet.availabilityZone.toString(), '^[0-9]{1}$')) {
          errors.push(
            `[VPC ${vpcItem.name} subnet ${subnet.name}]: Uses an incorrect value for ${subnet.availabilityZone} as the availabilityZone. Please use a single number.`,
          );
        }
      }
      if (subnet.localZone) {
        if (!helpers.matchesRegex(subnet.localZone, '^[a-z]{3}[-][0-9]{1}[a-z]{1}')) {
          errors.push(
            `[VPC ${vpcItem.name} subnet ${subnet.name}]: The local zone input provided is malformed. Please use the correct format starting with a hyphen (e.g. lax-1a).`,
          );
        }
      }
    });
  }

  /**
   * Validate that subnet specified in ALB exists
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateAlbConfigForExistingSubnets(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    for (const albItem of vpcItem.loadBalancers?.applicationLoadBalancers ?? []) {
      for (const subnetItem of albItem.subnets) {
        if (!helpers.getSubnet(vpcItem, subnetItem)) {
          errors.push(
            `The Application Load Balancer: ${albItem.name} for VPC ${vpcItem.name} is using subnet ${subnetItem} that doesn't exist`,
          );
        }
      }
    }
  }

  /**
   * Validate that ALB that is using sharedTargets has subnets that are also using shared targets method.
   * @param values
   * @param errors
   */
  private validateSharedAlbSubnets(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    const nonSharedSubnets: string[] = [];
    const invalidAlbs: { name: string; subnets: string[] }[] = [];
    for (const subnetItem of vpcItem.subnets ?? []) {
      if (!subnetItem.shareTargets) {
        nonSharedSubnets.push(subnetItem.name);
      }
    }
    for (const albItem of vpcItem.loadBalancers?.applicationLoadBalancers ?? []) {
      if (albItem.shareTargets) {
        this.validateSubnetSharesToAlbShares(albItem, vpcItem, helpers, errors);
        this.validateTargetGroupSharesToAlbShares(albItem, vpcItem, helpers, errors);
        if (albItem.subnets.find(item => nonSharedSubnets.find(nonSharedSubnet => item === nonSharedSubnet))) {
          invalidAlbs.push({ name: albItem.name, subnets: albItem.subnets });
        }
      }
    }

    for (const alb of invalidAlbs) {
      errors.push(
        `The Application Load Balancer: ${
          alb.name
        } is using the sharedTargets method, but at least one of the subnets [${alb.subnets.join(
          ',',
        )}] in its configuration is not using the sharedTargets method.`,
      );
    }
  }

  /**
   * Validate subnet availability to shared Application Load Balancers
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateSubnetSharesToAlbShares(
    albItem: ApplicationLoadBalancerConfig,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    let missingAccountIds: string[] = [];
    const albAccounts = helpers.getAccountNamesFromTarget(albItem.shareTargets as ShareTargets);
    for (const subnetName of albItem.subnets) {
      const subnetSharedTarget = this.getSubnetSharedTarget(vpcItem, subnetName);
      if (subnetSharedTarget) {
        const subnetAccounts = helpers.getAccountNamesFromTarget(subnetSharedTarget);
        missingAccountIds = albAccounts.filter(item => !subnetAccounts.includes(item));
        if (missingAccountIds.length > 0) {
          errors.push(
            `The Application Load Balancer ${albItem.name} is deployed to multiple accounts and using subnets that aren't available. Please make sure your sharedTargets configuration for your subnet makes the subnet available for the ALB.`,
          );
        }
      }
    }
  }

  /**
   * Validate Subnet share target OU names
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateVpcSubnetShareTargetOUs(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    for (const subnetItem of vpcItem.subnets ?? []) {
      for (const ou of subnetItem.shareTargets?.organizationalUnits ?? []) {
        if (!helpers.ouExists(ou)) {
          errors.push(
            `[VPC ${vpcItem.name} subnet ${subnetItem.name}]: Shared Target OU ${ou} does not exist in organization-config.yaml file.`,
          );
        }
      }
    }
  }

  /**
   * Validate Subnet share target account names
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateVpcSubnetShareTargetAccounts(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    for (const subnetItem of vpcItem.subnets ?? []) {
      for (const account of subnetItem.shareTargets?.accounts ?? []) {
        if (!helpers.accountExists(account)) {
          errors.push(
            `[VPC ${vpcItem.name} subnet ${subnetItem.name}]: Shared Target account ${account} does not exist in accounts-config.yaml file.`,
          );
        }
      }
    }
  }

  /**
   * Validate target group availability to shared Application Load Balancers
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateTargetGroupSharesToAlbShares(
    albItem: ApplicationLoadBalancerConfig,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    let missingAccountIds: string[] = [];

    const albAccounts = helpers.getAccountNamesFromTarget(albItem.shareTargets as ShareTargets);
    for (const listenerItem of albItem.listeners ?? []) {
      for (const targetGroupItem of vpcItem.targetGroups ?? []) {
        if (targetGroupItem.name === listenerItem.targetGroup) {
          const targetGroupSharedTarget = this.getTargetGroupSharedTarget(vpcItem, listenerItem.targetGroup);
          if (targetGroupSharedTarget) {
            const targetGroupAccounts = helpers.getAccountNamesFromTarget(targetGroupSharedTarget);
            missingAccountIds = albAccounts.filter(item => !targetGroupAccounts.includes(item));
            if (missingAccountIds.length > 0) {
              errors.push(
                `The Application Load Balancer ${albItem.name} is deployed to multiple accounts and using target group(s) that are not in the same accounts. Please make sure your sharedTargets configuration for your targetGroup makes the Target Group available for the ALB.`,
              );
            }
          }
        }
      }
    }
  }

  /**
   * Validate ACM availability to shared Application Load Balancers
   * @param values
   * @param vpcItem
   * @param helpers
   * @param errors
   */
  private validateAcmSharesToAlbShares(
    values: NetworkConfig,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    const invalidAlbList: string[] = [];
    let missingAccountIds: string[] = [];

    for (const acmItem of values.certificates ?? []) {
      for (const albItem of vpcItem.loadBalancers?.applicationLoadBalancers ?? []) {
        if (albItem.shareTargets) {
          const albAccounts = helpers.getAccountNamesFromTarget(albItem.shareTargets as ShareTargets);
          for (const listenerItem of albItem.listeners ?? []) {
            if (listenerItem.certificate === acmItem.name) {
              const acmAccountIds = helpers.getAccountNamesFromTarget(acmItem.deploymentTargets);
              missingAccountIds = albAccounts.filter(item => !acmAccountIds.includes(item));
              if (missingAccountIds.length > 0) {
                if (!invalidAlbList.includes(albItem.name)) {
                  invalidAlbList.push(albItem.name);
                }
              }
            }
          }
        }
      }
    }
    for (const alb of invalidAlbList) {
      errors.push(
        `The Application Load Balancer ${alb} is deployed to multiple accounts and using ACM certificate(s) that are not in the same accounts. Please make sure your sharedTargets configuration for your ACM certificates makes the Target Group available for the ALB.`,
      );
    }
  }

  /**
   * Returns the shared targets from the input of the subnet name.
   * @param vpcItem
   * @param subnetName
   * @returns
   */
  private getSubnetSharedTarget(vpcItem: VpcConfig | VpcTemplatesConfig, subnetName: string): ShareTargets | undefined {
    for (const subnetItem of vpcItem.subnets ?? []) {
      if (subnetItem.name === subnetName) {
        return subnetItem.shareTargets;
      }
    }
    return undefined;
  }

  /**
   * Returns the shared targets from the input of the target group name.
   * @param vpcItem
   * @param subnetName
   * @returns
   */
  private getTargetGroupSharedTarget(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    targetGroupName: string,
  ): ShareTargets | undefined {
    for (const targetGroupItem of vpcItem.targetGroups ?? []) {
      if (targetGroupItem.name === targetGroupName) {
        return targetGroupItem.shareTargets;
      }
    }
    return undefined;
  }

  /**
   * Returns a transit gateway config based on a given name and account
   * @param values
   * @param name
   * @param account
   * @returns
   */
  private getTransitGateway(values: NetworkConfig, name: string, account: string): TransitGatewayConfig | undefined {
    return values.transitGateways.find(tgw => tgw.name === name && tgw.account === account);
  }

  /**
   * Validate TGW attachments for a given VPC
   * @param values
   * @param vpcItem
   * @param errors
   */
  private validateTgwAttachments(
    values: NetworkConfig,
    vpcItem: VpcConfig | VpcTemplatesConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    const attachNames: string[] = [];
    const tgwNames: string[] = [];

    vpcItem.transitGatewayAttachments?.forEach(attach => {
      attachNames.push(attach.name);
      tgwNames.push(attach.transitGateway.name);
      const tgw = this.getTransitGateway(values, attach.transitGateway.name, attach.transitGateway.account);
      if (!tgw) {
        errors.push(
          `[VPC ${vpcItem.name} TGW attachment ${attach.name}]: TGW "${attach.transitGateway.name}" in account "${attach.transitGateway.account}" does not exist`,
        );
      } else {
        // Validate associations and propagations
        this.validateTgwRouteTableAssociations(vpcItem, attach, tgw, errors);
        this.validateTgwRouteTablePropagations(vpcItem, attach, tgw, helpers, errors);
        // Validate subnets
        this.validateTgwAttachmentSubnets(vpcItem, attach, helpers, errors);
        // Validate TGW region
        if (tgw.region !== vpcItem.region) {
          errors.push(
            `[VPC ${vpcItem.name} TGW attachment ${attach.name}]: TGW "${attach.transitGateway.name}" is not deployed to the same region as the VPC`,
          );
        }
      }
    });

    // Check for duplicate attachment names
    if (helpers.hasDuplicates(attachNames)) {
      errors.push(
        `[VPC ${vpcItem.name}]: duplicate TGW attachment names defined. Attachment names must be unique. Attachment names configured: ${attachNames}`,
      );
    }
    // Check for duplicate TGW attachments
    if (helpers.hasDuplicates(tgwNames)) {
      errors.push(
        `[VPC ${vpcItem.name}]: duplicate TGW attachment targets defined. Target TGWs must be unique. Attachment target TGWs configured: ${tgwNames}`,
      );
    }
  }

  /**
   * Validate TGW route table associations for a given VPC TGW attachment
   * @param vpcItem
   * @param attach
   * @param tgw
   * @param errors
   */
  private validateTgwRouteTableAssociations(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    attach: TransitGatewayAttachmentConfig,
    tgw: TransitGatewayConfig,
    errors: string[],
  ) {
    // Check number of associations
    if (attach.routeTableAssociations && attach.routeTableAssociations.length > 1) {
      errors.push(
        `[VPC ${vpcItem.name} TGW attachment ${attach.name}]: cannot define more than one TGW route table association`,
      );
    }
    // Validate route table exists
    if (
      attach.routeTableAssociations &&
      !tgw.routeTables.find(table => table.name === attach.routeTableAssociations![0])
    ) {
      errors.push(
        `[VPC ${vpcItem.name} TGW attachment ${attach.name}]: route table "${attach.routeTableAssociations[0]}" does not exist on TGW "${tgw.name}"`,
      );
    }
  }

  /**
   * Validate TGW route table propagations for a given VPC TGW attachment
   * @param vpcItem
   * @param attach
   * @param tgw
   * @param helpers
   * @param errors
   */
  private validateTgwRouteTablePropagations(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    attach: TransitGatewayAttachmentConfig,
    tgw: TransitGatewayConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    const tableNames: string[] = [];
    attach.routeTablePropagations?.forEach(propagation => {
      tableNames.push(propagation);
      if (!tgw.routeTables.find(table => table.name === propagation)) {
        errors.push(
          `[VPC ${vpcItem.name} TGW attachment ${attach.name}]: route table "${propagation}" does not exist on TGW "${tgw.name}"`,
        );
      }
    });

    // Check for duplicate route table names
    if (helpers.hasDuplicates(tableNames)) {
      errors.push(
        `[VPC ${vpcItem.name} TGW attachment ${attach.name}]: duplicate TGW route table propagations defined. Propagations must be unique. Propagations configured: ${tableNames}`,
      );
    }
  }

  /**
   * Validate TGW attachment target subnets
   * @param vpcItem
   * @param attach
   * @param helpers
   * @param errors
   */
  private validateTgwAttachmentSubnets(
    vpcItem: VpcConfig | VpcTemplatesConfig,
    attach: TransitGatewayAttachmentConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    const subnetAzs: (string | number)[] = [];
    const subnetNames: string[] = [];
    const localZoneSubnets: string[] = [];

    attach.subnets.forEach(subnetName => {
      subnetNames.push(subnetName);
      const subnet = helpers.getSubnet(vpcItem, subnetName);
      if (!subnet) {
        errors.push(
          `[VPC ${vpcItem.name} TGW attachment ${attach.name}]: target subnet "${subnetName}" does not exist in VPC "${vpcItem.name}"`,
        );
      } else {
        subnetAzs.push(subnet.availabilityZone ? subnet.availabilityZone : '');
      }
      if (subnet?.localZone) {
        localZoneSubnets.push(subnet.name);
      }
    });

    // Check for duplicate subnet names
    if (helpers.hasDuplicates(subnetNames)) {
      errors.push(
        `[VPC ${vpcItem.name} TGW attachment ${attach.name}]: duplicate TGW attachment subnets defined. Subnets must be unique. Subnets configured: ${subnetNames}`,
      );
    }
    // Check for duplicate subnet AZs
    if (helpers.hasDuplicates(subnetAzs)) {
      errors.push(
        `[VPC ${vpcItem.name} TGW attachment ${attach.name}]: duplicate TGW attachment subnet AZs defined. Subnet AZs must be unique. AZs configured: ${subnetAzs}`,
      );
    }
    // Check if any subnets that are created in local zones are attached to TGW
    if (localZoneSubnets.length > 0) {
      errors.push(
        `[VPC ${vpcItem.name} TGW attachment ${attach.name}]: TGW attachment contains subnets: ${localZoneSubnets.join(
          ', ',
        )} that are created in local zones which is not valid. Please remove from tgw attachment config. `,
      );
    }
  }

  /**
   * Validate Outpost Local Gateway names
   * @param values
   * @param helpers
   * @param errors
   */
  private validateLocalGatewayNames(values: NetworkConfig, helpers: NetworkValidatorFunctions, errors: string[]) {
    values.vpcs.forEach(vpcItem => {
      const lgwNames = [];
      if (vpcItem.outposts) {
        for (const outpost of vpcItem.outposts) {
          if (outpost.localGateway?.name) {
            lgwNames.push(outpost.localGateway?.name);
          }
        }

        // Validate no VPC names are duplicated
        if (helpers.hasDuplicates(lgwNames)) {
          errors.push(`Duplicate Local Gateway names exist, LGW names must be unique. LGW names in file: ${lgwNames}`);
        }
      }
    });
  }

  /**
   * Validate uniqueness of Outpost names
   * @param values
   * @param helpers
   * @param errors
   */
  private validateOutpostNames(values: NetworkConfig, helpers: NetworkValidatorFunctions, errors: string[]) {
    values.vpcs.forEach(vpcItem => {
      const outpostNames = [];
      if (vpcItem.outposts) {
        for (const outpost of vpcItem.outposts) {
          outpostNames.push(outpost.name);
        }

        // Validate no VPC names are duplicated
        if (helpers.hasDuplicates(outpostNames)) {
          errors.push(
            `Duplicate Outpost names exist, Outpost names must be unique. Outpost names in file: ${outpostNames}`,
          );
        }
      }
    });
  }

  /**
   * Validate VPC peering connections
   * @param values
   * @param errors
   */
  private validateVpcPeeringConfiguration(values: NetworkConfig, errors: string[]) {
    const vpcs = [...values.vpcs, ...(values.vpcTemplates ?? [])];
    const vpcTemplates = values.vpcTemplates ?? [];
    for (const peering of values.vpcPeering ?? []) {
      // Ensure exactly two VPCs are defined
      if (peering.vpcs.length < 2 || peering.vpcs.length > 2) {
        errors.push(
          `[VPC peering connection ${peering.name}]: exactly two VPCs must be defined for a VPC peering connection`,
        );
      }

      // Ensure VPCs exist and more than one is not defined
      for (const vpc of peering.vpcs) {
        if (!vpcs.find(item => item.name === vpc)) {
          errors.push(`[VPC peering connection ${peering.name}]: VPC or VPC Template ${vpc} does not exist`);
        }
        if (vpcs.filter(item => item.name === vpc).length > 1) {
          errors.push(`[VPC peering connection ${peering.name}]: more than one VPC or VPC Template named ${vpc}`);
        }
      }

      // Ensure not both vpcs are from vpcTemplates
      if (
        vpcTemplates.find(item => item.name === peering.vpcs[0]) &&
        vpcTemplates.find(item => item.name === peering.vpcs[1])
      ) {
        errors.push(
          `[VPC peering connection ${peering.name}]: Both VPCs ${peering.vpcs[0]}, ${peering.vpcs[1]} should not be from vpcTemplates. Only one VPC in a peering connection can be from vpcTemplate configuration`,
        );
      }
    }
  }

  /**
   * Validate default VPC configuration
   * @param values
   * @param helpers
   * @param global
   * @param errors
   */
  private validateDefaultVpcConfiguration(values: NetworkConfig, helpers: NetworkValidatorFunctions, errors: string[]) {
    this.validateDefaultVpcRegionConfiguration(values, helpers, errors);
    this.validateDefaultVpcAccountConfiguration(values, helpers, errors);
  }

  /**
   * Validate default VPC region excludes configuration
   * @param values
   * @param helpers
   * @param global
   * @param errors
   */
  private validateDefaultVpcRegionConfiguration(
    values: NetworkConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    const invalidRegions: string[] = [];
    for (const region of values.defaultVpc.excludeRegions ?? []) {
      const validRegion = helpers.isEnabledRegion(region);
      if (!validRegion) {
        invalidRegions.push(region);
      }
    }
    if (invalidRegions.length > 0) {
      errors.push(
        `[Default Vpc Configuration contains the following regions that are not in the enabledRegions: ${invalidRegions.join(
          ', ',
        )}`,
      );
    }
  }

  /**
   * Validate default VPC account excludes configuration
   * @param values
   * @param helpers
   * @param global
   * @param errors
   */
  private validateDefaultVpcAccountConfiguration(
    values: NetworkConfig,
    helpers: NetworkValidatorFunctions,
    errors: string[],
  ) {
    const invalidAccounts: string[] = [];
    for (const account of values.defaultVpc.excludeAccounts ?? []) {
      if (!helpers.accountExists(account)) {
        invalidAccounts.push(account);
      }
    }
    if (invalidAccounts.length > 0) {
      errors.push(
        `[Default Vpc Configuration contains the following accounts that are not in the accounts config: ${invalidAccounts.join(
          ', ',
        )}`,
      );
    }
  }
}
