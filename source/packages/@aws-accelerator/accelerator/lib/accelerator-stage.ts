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
export enum AcceleratorStage {
  PIPELINE = 'pipeline',
  /**
   * Accelerator Tester Pipeline
   */
  TESTER_PIPELINE = 'tester-pipeline',
  /**
   * Prepare Stage - Verify the configuration files, environment and create accounts
   */
  PREPARE = 'prepare',
  /**
   * DiagnosticsPack Stage - Creates Diagnostics pack resources
   */
  DIAGNOSTICS_PACK = 'diagnostics-pack',
  ORGANIZATIONS = 'organizations',
  KEY = 'key',
  LOGGING = 'logging',
  /**
   * Accounts Stage - Handle all Organization and Accounts actions
   */
  ACCOUNTS = 'accounts',
  BOOTSTRAP = 'bootstrap',
  CUSTOMIZATIONS = 'customizations',
  DEPENDENCIES = 'dependencies',
  SECURITY = 'security',
  SECURITY_RESOURCES = 'security-resources',
  OPERATIONS = 'operations',
  IDENTITY_CENTER = 'identity-center',
  NETWORK_PREP = 'network-prep',
  NETWORK_VPC = 'network-vpc',
  NETWORK_VPC_ENDPOINTS = 'network-vpc-endpoints',
  NETWORK_VPC_DNS = 'network-vpc-dns',
  NETWORK_ASSOCIATIONS = 'network-associations',
  NETWORK_ASSOCIATIONS_GWLB = 'network-associations-gwlb',
  SECURITY_AUDIT = 'security-audit',
  RESOURCE_POLICY_ENFORCEMENT = 'resource-policy-enforcement',
  FINALIZE = 'finalize',
  IMPORT_ASEA_RESOURCES = 'import-asea-resources',
  POST_IMPORT_ASEA_RESOURCES = 'post-import-asea-resources',
}
