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
import { NagSuppressions } from 'cdk-nag';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as codecommit from 'aws-cdk-lib/aws-codecommit';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as codepipeline_actions from 'aws-cdk-lib/aws-codepipeline-actions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

import { Bucket, BucketEncryptionType, ServiceLinkedRole } from '@aws-accelerator/constructs';
import { AcceleratorStage } from './accelerator-stage';
import * as config_repository from './config-repository';
import { AcceleratorToolkitCommand } from './toolkit';
import { Repository } from '@aws-cdk-extensions/cdk-extensions';
import { CONTROL_TOWER_LANDING_ZONE_VERSION } from '@aws-accelerator/utils/lib/control-tower';
import { ControlTowerLandingZoneConfig } from '@aws-accelerator/config';

/**
 *
 */
export interface AcceleratorPipelineProps {
  readonly toolkitRole: cdk.aws_iam.Role;
  readonly awsCodeStarSupportedRegions: string[];
  readonly sourceRepository: string;
  readonly sourceRepositoryOwner: string;
  readonly sourceRepositoryName: string;
  readonly sourceBranchName: string;
  readonly enableApprovalStage: boolean;
  readonly qualifier?: string;
  readonly managementAccountId?: string;
  readonly managementAccountRoleName?: string;
  readonly managementAccountEmail: string;
  readonly logArchiveAccountEmail: string;
  readonly auditAccountEmail: string;
  readonly controlTowerEnabled: string;
  /**
   * List of email addresses to be notified when pipeline is waiting for manual approval stage.
   * If pipeline do not have approval stage enabled, this value will have no impact.
   */
  readonly approvalStageNotifyEmailList?: string;
  readonly partition: string;
  /**
   * Indicates location of the LZA configuration files
   */
  readonly configRepositoryLocation: 'codecommit' | 's3';
  /**
   * Flag indicating installer using existing CodeCommit repository
   */
  readonly useExistingConfigRepo: boolean;
  /**
   * User defined pre-existing config repository name
   */
  readonly configRepositoryName: string;
  /**
   * User defined pre-existing config repository branch name
   */
  readonly configRepositoryBranchName: string;
  /**
   * Accelerator resource name prefixes
   */
  readonly prefixes: {
    /**
     * Use this prefix value to name resources like -
     AWS IAM Role names, AWS Lambda Function names, AWS Cloudwatch log groups names, AWS CloudFormation stack names, AWS CodePipeline names, AWS CodeBuild project names
     *
     */
    readonly accelerator: string;
    /**
     * Use this prefix value to name AWS CodeCommit repository
     */
    readonly repoName: string;
    /**
     * Use this prefix value to name AWS S3 bucket
     */
    readonly bucketName: string;
    /**
     * Use this prefix value to name AWS SSM parameter
     */
    readonly ssmParamName: string;
    /**
     * Use this prefix value to name AWS KMS alias
     */
    readonly kmsAlias: string;
    /**
     * Use this prefix value to name AWS SNS topic
     */
    readonly snsTopicName: string;
    /**
     * Use this prefix value to name AWS Secrets
     */
    readonly secretName: string;
    /**
     * Use this prefix value to name AWS CloudTrail CloudWatch log group
     */
    readonly trailLogName: string;
    /**
     * Use this prefix value to name AWS Glue database
     */
    readonly databaseName: string;
  };
  /**
   * Boolean for single account mode (i.e. AWS Jam or Workshop)
   */
  readonly enableSingleAccountMode: boolean;
  /**
   * Accelerator pipeline account id, for external deployment it will be pipeline account otherwise management account
   */
  pipelineAccountId: string;
  /**
   * Flag indicating existing role
   */
  readonly useExistingRoles: boolean;
  /**
   * AWS Control Tower Landing Zone identifier
   */
  readonly landingZoneIdentifier?: string;
}

enum BuildLogLevel {
  ERROR = 'error',
  INFO = 'info',
}

/**
 * AWS Accelerator Pipeline Class, which creates the pipeline for AWS Landing zone
 */
export class AcceleratorPipeline extends Construct {
  private readonly pipelineRole: iam.Role;
  private readonly toolkitProject: codebuild.PipelineProject;
  private readonly buildOutput: codepipeline.Artifact;
  private readonly acceleratorRepoArtifact: codepipeline.Artifact;
  private readonly configRepoArtifact: codepipeline.Artifact;

  private readonly pipeline: codepipeline.Pipeline;
  private readonly props: AcceleratorPipelineProps;
  private readonly installerKey: cdk.aws_kms.Key;
  private readonly configBucketName: string;
  private readonly serverAccessLogsBucketNameSsmParam: string;
  private readonly controlTowerLandingZoneConfig?: ControlTowerLandingZoneConfig;

  constructor(scope: Construct, id: string, props: AcceleratorPipelineProps) {
    super(scope, id);

    this.props = props;

    //
    // Get default AWS Control Tower Landing Zone configuration
    //
    this.controlTowerLandingZoneConfig = this.getControlTowerLandingZoneConfiguration();

    //
    // Fields can be changed based on qualifier property
    let acceleratorKeyArnSsmParameterName = `${props.prefixes.ssmParamName}/installer/kms/key-arn`;
    let secureBucketName = `${props.prefixes.bucketName}-pipeline-${cdk.Stack.of(this).account}-${
      cdk.Stack.of(this).region
    }`;
    this.configBucketName = `${props.prefixes.bucketName}-config-${cdk.Stack.of(this).account}-${
      cdk.Stack.of(this).region
    }`;
    this.serverAccessLogsBucketNameSsmParam = `${props.prefixes.ssmParamName}/installer-access-logs-bucket-name`;
    let pipelineName = `${props.prefixes.accelerator}-Pipeline`;
    let buildProjectName = `${props.prefixes.accelerator}-BuildProject`;
    let toolkitProjectName = `${props.prefixes.accelerator}-ToolkitProject`;

    //
    // Change the fields when qualifier is present
    if (this.props.qualifier) {
      acceleratorKeyArnSsmParameterName = `${props.prefixes.ssmParamName}/${this.props.qualifier}/installer/kms/key-arn`;
      secureBucketName = `${this.props.qualifier}-pipeline-${cdk.Stack.of(this).account}-${cdk.Stack.of(this).region}`;
      this.configBucketName = `${this.props.qualifier}-config-${cdk.Stack.of(this).account}-${
        cdk.Stack.of(this).region
      }`;
      this.serverAccessLogsBucketNameSsmParam = `${props.prefixes.ssmParamName}/${this.props.qualifier}/installer-access-logs-bucket-name`;
      pipelineName = `${this.props.qualifier}-pipeline`;
      buildProjectName = `${this.props.qualifier}-build-project`;
      toolkitProjectName = `${this.props.qualifier}-toolkit-project`;
    }

    let pipelineAccountEnvVariables: { [p: string]: codebuild.BuildEnvironmentVariable } | undefined;

    if (this.props.managementAccountId && this.props.managementAccountRoleName) {
      pipelineAccountEnvVariables = {
        MANAGEMENT_ACCOUNT_ID: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: this.props.managementAccountId,
        },
        MANAGEMENT_ACCOUNT_ROLE_NAME: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: this.props.managementAccountRoleName,
        },
      };
    }

    let enableSingleAccountModeEnvVariables: { [p: string]: codebuild.BuildEnvironmentVariable } | undefined;
    if (props.enableSingleAccountMode) {
      enableSingleAccountModeEnvVariables = {
        ACCELERATOR_ENABLE_SINGLE_ACCOUNT_MODE: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: true,
        },
      };
    }

    const enableAseaMigration = process.env['ENABLE_ASEA_MIGRATION']?.toLowerCase?.() === 'true';

    let aseaMigrationModeEnvVariables: { [p: string]: codebuild.BuildEnvironmentVariable } | undefined;
    if (enableAseaMigration) {
      aseaMigrationModeEnvVariables = {
        ENABLE_ASEA_MIGRATION: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: 'true',
        },
        ASEA_MAPPING_BUCKET: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: `${props.prefixes.accelerator}-lza-resource-mapping-${cdk.Stack.of(this).account}`.toLowerCase(),
        },
        ASEA_MAPPING_FILE: {
          type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
          value: 'aseaResources.json',
        },
      };
    }

    // Get installer key
    this.installerKey = cdk.aws_kms.Key.fromKeyArn(
      this,
      'AcceleratorKey',
      cdk.aws_ssm.StringParameter.valueForStringParameter(this, acceleratorKeyArnSsmParameterName),
    ) as cdk.aws_kms.Key;

    const bucket = new Bucket(this, 'SecureBucket', {
      encryptionType: BucketEncryptionType.SSE_KMS,
      s3BucketName: secureBucketName,
      kmsKey: this.installerKey,
      serverAccessLogsBucketName: cdk.aws_ssm.StringParameter.valueForStringParameter(
        this,
        this.serverAccessLogsBucketNameSsmParam,
      ),
    });

    /**
     * Pipeline
     */
    this.pipelineRole = new iam.Role(this, 'PipelineRole', {
      assumedBy: new iam.ServicePrincipal('codepipeline.amazonaws.com'),
    });

    this.pipeline = new codepipeline.Pipeline(this, 'Resource', {
      pipelineName: pipelineName,
      artifactBucket: bucket.getS3Bucket(),
      role: this.pipelineRole,
    });

    this.acceleratorRepoArtifact = new codepipeline.Artifact('Source');
    this.configRepoArtifact = new codepipeline.Artifact('Config');

    let sourceAction:
      | cdk.aws_codepipeline_actions.CodeCommitSourceAction
      | cdk.aws_codepipeline_actions.GitHubSourceAction;

    if (this.props.sourceRepository === 'codecommit') {
      sourceAction = new codepipeline_actions.CodeCommitSourceAction({
        actionName: 'Source',
        repository: codecommit.Repository.fromRepositoryName(this, 'SourceRepo', this.props.sourceRepositoryName),
        branch: this.props.sourceBranchName,
        output: this.acceleratorRepoArtifact,
        trigger: codepipeline_actions.CodeCommitTrigger.NONE,
      });
    } else {
      sourceAction = new cdk.aws_codepipeline_actions.GitHubSourceAction({
        actionName: 'Source',
        owner: this.props.sourceRepositoryOwner,
        repo: this.props.sourceRepositoryName,
        branch: this.props.sourceBranchName,
        oauthToken: cdk.SecretValue.secretsManager('accelerator/github-token'),
        output: this.acceleratorRepoArtifact,
        trigger: cdk.aws_codepipeline_actions.GitHubTrigger.NONE,
      });
    }

    if (this.props.configRepositoryLocation === 's3') {
      const s3ConfigRepository = this.getS3ConfigRepository();
      this.pipeline.addStage({
        stageName: 'Source',
        actions: [
          sourceAction,
          new codepipeline_actions.S3SourceAction({
            actionName: 'Configuration',
            bucket: s3ConfigRepository,
            bucketKey: 'zipped/aws-accelerator-config.zip',
            output: this.configRepoArtifact,
            trigger: codepipeline_actions.S3Trigger.NONE,
            variablesNamespace: 'Config-Vars',
          }),
        ],
      });
    } else {
      const configRepositoryBranchName = this.props.useExistingConfigRepo
        ? this.props.configRepositoryBranchName ?? 'main'
        : 'main';
      const codecommitConfigRepository = this.getCodeCommitConfigRepository(configRepositoryBranchName);
      this.pipeline.addStage({
        stageName: 'Source',
        actions: [
          sourceAction,
          new codepipeline_actions.CodeCommitSourceAction({
            actionName: 'Configuration',
            repository: codecommitConfigRepository,
            branch: configRepositoryBranchName,
            output: this.configRepoArtifact,
            trigger: codepipeline_actions.CodeCommitTrigger.NONE,
            variablesNamespace: 'Config-Vars',
          }),
        ],
      });
    }

    /**
     * Build Stage
     */
    const buildRole = new iam.Role(this, 'BuildRole', {
      assumedBy: new iam.ServicePrincipal('codebuild.amazonaws.com'),
    });

    const validateConfigPolicyDocument = new cdk.aws_iam.PolicyDocument({
      statements: [
        new cdk.aws_iam.PolicyStatement({
          effect: cdk.aws_iam.Effect.ALLOW,
          actions: ['organizations:ListAccounts', 'ssm:GetParameter'],
          resources: ['*'],
        }),
      ],
    });

    const validateConfigPolicy = new cdk.aws_iam.ManagedPolicy(this, 'ValidateConfigPolicyDocument', {
      document: validateConfigPolicyDocument,
    });
    buildRole.addManagedPolicy(validateConfigPolicy);

    if (this.props.managementAccountId && this.props.managementAccountRoleName) {
      const assumeExternalDeploymentRolePolicyDocument = new cdk.aws_iam.PolicyDocument({
        statements: [
          new cdk.aws_iam.PolicyStatement({
            effect: cdk.aws_iam.Effect.ALLOW,
            actions: ['sts:AssumeRole'],
            resources: [
              `arn:${this.props.partition}:iam::${this.props.managementAccountId}:role/${this.props.managementAccountRoleName}`,
            ],
          }),
        ],
      });

      /**
       * Create an IAM Policy for the build role to be able to lookup replacement parameters in the external deployment
       * target account
       */
      const assumeExternalDeploymentRolePolicy = new cdk.aws_iam.ManagedPolicy(this, 'AssumeExternalDeploymentPolicy', {
        document: assumeExternalDeploymentRolePolicyDocument,
      });
      buildRole.addManagedPolicy(assumeExternalDeploymentRolePolicy);
    }

    // Pipeline/BuildRole/Resource AwsSolutions-IAM4: The IAM user, role, or group uses AWS managed policies.
    NagSuppressions.addResourceSuppressionsByPath(
      cdk.Stack.of(this),
      `${cdk.Stack.of(this).stackName}/Pipeline/BuildRole/Resource`,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWS Managed policy for External Pipeline Deployment Lookups attached.',
        },
      ],
    );

    const buildProject = new codebuild.PipelineProject(this, 'BuildProject', {
      projectName: buildProjectName,
      encryptionKey: this.installerKey,
      role: buildRole,
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              nodejs: 18,
            },
          },
          pre_build: {
            commands: [
              `export PACKAGE_VERSION=$(cat source/package.json | grep version | head -1 | awk -F: '{ print $2 }' | sed 's/[",]//g' | tr -d '[:space:]')`,
              `if [ "$ACCELERATOR_CHECK_VERSION" = "yes" ]; then 
                if [ "$PACKAGE_VERSION" != "$ACCELERATOR_PIPELINE_VERSION" ]; then
                  echo "ERROR: Accelerator package version in Source does not match currently installed LZA version. Please ensure that the Installer stack has been updated prior to updating the Source code in CodePipeline."
                  exit 1
                fi
              fi`,
            ],
          },
          build: {
            commands: [
              'env',
              'cd source',
              `if [ "${cdk.Stack.of(this).partition}" = "aws-cn" ]; then
                  sed -i "s#registry.yarnpkg.com#registry.npmmirror.com#g" yarn.lock;
                  yarn config set registry https://registry.npmmirror.com
               fi`,
              'yarn install',
              'yarn build',
              'yarn validate-config $CODEBUILD_SRC_DIR_Config',
            ],
          },
        },
        artifacts: {
          files: ['**/*'],
          'enable-symlinks': 'yes',
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: false,
        computeType: codebuild.ComputeType.LARGE,
        environmentVariables: {
          NODE_OPTIONS: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: '--max_old_space_size=12288',
          },
          PARTITION: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: cdk.Stack.of(this).partition,
          },
          ACCELERATOR_PIPELINE_VERSION: {
            type: codebuild.BuildEnvironmentVariableType.PARAMETER_STORE,
            value: `${props.prefixes.ssmParamName}/${cdk.Stack.of(this).stackName}/version`,
          },
          ACCELERATOR_CHECK_VERSION: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: 'yes',
          },
          ...enableSingleAccountModeEnvVariables,
          ...pipelineAccountEnvVariables,
        },
      },
      cache: codebuild.Cache.local(codebuild.LocalCacheMode.SOURCE),
    });

    this.buildOutput = new codepipeline.Artifact('Build');

    this.pipeline.addStage({
      stageName: 'Build',
      actions: [
        new codepipeline_actions.CodeBuildAction({
          actionName: 'Build',
          project: buildProject,
          input: this.acceleratorRepoArtifact,
          extraInputs: [this.configRepoArtifact],
          outputs: [this.buildOutput],
          role: this.pipelineRole,
        }),
      ],
    });

    /**
     * Deploy Stage
     */

    this.toolkitProject = new codebuild.PipelineProject(this, 'ToolkitProject', {
      projectName: toolkitProjectName,
      encryptionKey: this.installerKey,
      role: this.props.toolkitRole,
      timeout: cdk.Duration.hours(8),
      buildSpec: codebuild.BuildSpec.fromObject({
        version: '0.2',
        phases: {
          install: {
            'runtime-versions': {
              nodejs: 18,
            },
          },
          build: {
            commands: [
              'env',
              'cd source',
              `if [ "prepare" = "\${ACCELERATOR_STAGE}" ]; then set -e && LOG_LEVEL=${
                BuildLogLevel.INFO
              } yarn run ts-node packages/@aws-accelerator/modules/bin/runner.ts --module control-tower --partition ${
                cdk.Aws.PARTITION
              } --use-existing-role ${
                this.props.useExistingRoles ? 'Yes' : 'No'
              } --config-dir $CODEBUILD_SRC_DIR_Config && if [ -z "\${ACCELERATOR_NO_ORG_MODULE}" ]; then LOG_LEVEL=${
                BuildLogLevel.INFO
              } yarn run ts-node packages/@aws-accelerator/modules/bin/runner.ts --module aws-organizations --partition  ${
                cdk.Aws.PARTITION
              } --use-existing-role ${
                this.props.useExistingRoles ? 'Yes' : 'No'
              } --config-dir $CODEBUILD_SRC_DIR_Config; else echo "Module aws-organizations execution skipped by environment settings."; fi ; fi`,
              `if [ "prepare" = "\${ACCELERATOR_STAGE}" ]; then set -e && yarn run ts-node  packages/@aws-accelerator/accelerator/lib/prerequisites.ts --config-dir $CODEBUILD_SRC_DIR_Config --partition ${cdk.Aws.PARTITION} --minimal; fi`,
              'cd packages/@aws-accelerator/accelerator',
              'export FULL_SYNTH="true"',
              'if [ $ASEA_MAPPING_BUCKET ]; then aws s3api head-object --bucket $ASEA_MAPPING_BUCKET --key $ASEA_MAPPING_FILE >/dev/null 2>&1 || export FULL_SYNTH="false"; fi;',
              `if [ -z "\${ACCELERATOR_STAGE}" ] && [ $CDK_OPTIONS = 'bootstrap' ] && [ $FULL_SYNTH = "true" ]; then for STAGE in "key" "logging" "organizations" "security-audit" "network-prep" "security" "operations" "identity-center" "network-vpc" "security-resources" "network-associations" "customizations" "finalize" "bootstrap"; do set -e && yarn run ts-node --transpile-only cdk.ts synth --require-approval never --config-dir $CODEBUILD_SRC_DIR_Config --partition ${cdk.Aws.PARTITION} --stage $STAGE; done; fi`,
              `if [ -z "\${ACCELERATOR_STAGE}" ] && [ $CDK_OPTIONS = 'diff' ] && [ $FULL_SYNTH = "true" ]; then for STAGE in "key" "logging" "organizations" "security-audit" "network-prep" "security" "operations" "identity-center" "network-vpc" "security-resources" "network-associations" "customizations" "finalize" "bootstrap"; do set -e && yarn run ts-node --transpile-only cdk.ts synth --require-approval never --config-dir $CODEBUILD_SRC_DIR_Config --partition ${cdk.Aws.PARTITION} --stage $STAGE; done; fi`,
              `if [ -z "\${ACCELERATOR_STAGE}" ] && [ $CDK_OPTIONS = 'bootstrap' ] && [ $FULL_SYNTH = "false" ]; then for STAGE in  "bootstrap"; do set -e && yarn run ts-node --transpile-only cdk.ts synth --require-approval never --config-dir $CODEBUILD_SRC_DIR_Config --partition ${cdk.Aws.PARTITION} --stage $STAGE; done; fi`,
              `if [ ! -z "\${ACCELERATOR_STAGE}" ]; then yarn run ts-node --transpile-only cdk.ts synth --stage $ACCELERATOR_STAGE --require-approval never --config-dir $CODEBUILD_SRC_DIR_Config --partition ${cdk.Aws.PARTITION}; fi`,
              `if [ "diff" != "\${CDK_OPTIONS}" ]; then yarn run ts-node --transpile-only cdk.ts --require-approval never $CDK_OPTIONS --config-dir $CODEBUILD_SRC_DIR_Config --partition ${cdk.Aws.PARTITION} --app cdk.out; fi`,
              `if [ "diff" = "\${CDK_OPTIONS}" ]; then for STAGE in "key" "logging" "organizations" "security-audit" "network-prep" "security" "operations" "identity-center" "network-vpc" "security-resources" "network-associations" "customizations" "finalize" "bootstrap"; do set -e && yarn run ts-node --transpile-only cdk.ts --require-approval never $CDK_OPTIONS --config-dir $CODEBUILD_SRC_DIR_Config --partition ${cdk.Aws.PARTITION} --app cdk.out --stage $STAGE; done; find ./cdk.out -type f -name "*.diff" -exec cat "{}" \\;;  fi`,
              `if [ "prepare" = "\${ACCELERATOR_STAGE}" ]; then cd ../../../ && set -e && yarn run ts-node  packages/@aws-accelerator/accelerator/lib/prerequisites.ts --config-dir $CODEBUILD_SRC_DIR_Config --partition ${cdk.Aws.PARTITION}; fi`,
            ],
          },
        },
      }),
      environment: {
        buildImage: codebuild.LinuxBuildImage.STANDARD_7_0,
        privileged: false, // Allow access to the Docker daemon
        computeType: codebuild.ComputeType.LARGE,
        environmentVariables: {
          LOG_LEVEL: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: BuildLogLevel.ERROR,
          },
          NODE_OPTIONS: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: '--max_old_space_size=12288',
          },
          CDK_METHOD: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: 'direct',
          },
          CDK_NEW_BOOTSTRAP: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: '1',
          },
          ACCELERATOR_QUALIFIER: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: this.props.qualifier ? this.props.qualifier : 'aws-accelerator',
          },
          ACCELERATOR_PREFIX: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: props.prefixes.accelerator,
          },
          ACCELERATOR_REPO_NAME_PREFIX: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: props.prefixes.repoName,
          },
          ACCELERATOR_BUCKET_NAME_PREFIX: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: props.prefixes.bucketName,
          },
          ACCELERATOR_KMS_ALIAS_PREFIX: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: props.prefixes.kmsAlias,
          },
          ACCELERATOR_SSM_PARAM_NAME_PREFIX: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: props.prefixes.ssmParamName,
          },
          ACCELERATOR_SNS_TOPIC_NAME_PREFIX: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: props.prefixes.snsTopicName,
          },
          ACCELERATOR_SECRET_NAME_PREFIX: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: props.prefixes.secretName,
          },
          ACCELERATOR_TRAIL_LOG_NAME_PREFIX: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: props.prefixes.trailLogName,
          },
          ACCELERATOR_DATABASE_NAME_PREFIX: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: props.prefixes.databaseName,
          },
          PIPELINE_ACCOUNT_ID: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: props.pipelineAccountId,
          },
          ENABLE_DIAGNOSTICS_PACK: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: process.env['ENABLE_DIAGNOSTICS_PACK'] ?? 'Yes',
          },
          INSTALLER_STACK_NAME: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: process.env['INSTALLER_STACK_NAME'] ?? '',
          },
          ACCELERATOR_PERMISSION_BOUNDARY: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: process.env['ACCELERATOR_PERMISSION_BOUNDARY'] ?? '',
          },
          CONFIG_REPOSITORY_LOCATION: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: process.env['CONFIG_REPOSITORY_LOCATION'] ?? 'codecommit',
          },
          ACCELERATOR_SKIP_PREREQUISITES: {
            type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
            value: 'true',
          },
          ...enableSingleAccountModeEnvVariables,
          ...pipelineAccountEnvVariables,
          ...aseaMigrationModeEnvVariables,
        },
      },
      cache: codebuild.Cache.local(codebuild.LocalCacheMode.SOURCE),
    });

    // /**
    //  * The Prepare stage is used to verify that all prerequisites have been made and that the
    //  * Accelerator can be deployed into the environment
    //  * Creates the accounts
    //  * Creates the ou's if control tower is not enabled
    //  */
    this.pipeline.addStage({
      stageName: 'Prepare',
      actions: [this.createToolkitStage({ actionName: 'Prepare', command: 'deploy', stage: AcceleratorStage.PREPARE })],
    });

    this.pipeline.addStage({
      stageName: 'Accounts',
      actions: [
        this.createToolkitStage({ actionName: 'Accounts', command: 'deploy', stage: AcceleratorStage.ACCOUNTS }),
      ],
    });

    this.pipeline.addStage({
      stageName: 'Bootstrap',
      actions: [this.createToolkitStage({ actionName: 'Bootstrap', command: `bootstrap` })],
    });

    //
    // Add review stage based on parameter
    this.addReviewStage();

    /**
     * The Logging stack establishes all the logging assets that are needed in
     * all the accounts and will configure:
     *
     * - An S3 Access Logs bucket for every region in every account
     * - The Central Logs bucket in the log-archive account
     *
     */
    this.pipeline.addStage({
      stageName: 'Logging',
      actions: [
        this.createToolkitStage({ actionName: 'Key', command: 'deploy', stage: AcceleratorStage.KEY, runOrder: 1 }),
        this.createToolkitStage({
          actionName: 'Logging',
          command: 'deploy',
          stage: AcceleratorStage.LOGGING,
          runOrder: 2,
        }),
      ],
    });

    // Adds ASEA Import Resources stage
    if (enableAseaMigration) {
      this.pipeline.addStage({
        stageName: 'ImportAseaResources',
        actions: [
          this.createToolkitStage({
            actionName: 'Import_Asea_Resources',
            command: `deploy`,
            stage: AcceleratorStage.IMPORT_ASEA_RESOURCES,
          }),
        ],
      });
    }

    this.pipeline.addStage({
      stageName: 'Organization',
      actions: [
        this.createToolkitStage({
          actionName: 'Organizations',
          command: 'deploy',
          stage: AcceleratorStage.ORGANIZATIONS,
        }),
      ],
    });

    this.pipeline.addStage({
      stageName: 'SecurityAudit',
      actions: [
        this.createToolkitStage({
          actionName: 'SecurityAudit',
          command: 'deploy',
          stage: AcceleratorStage.SECURITY_AUDIT,
        }),
      ],
    });

    this.pipeline.addStage({
      stageName: 'Deploy',
      actions: [
        this.createToolkitStage({
          actionName: 'Network_Prepare',
          command: 'deploy',
          stage: AcceleratorStage.NETWORK_PREP,
          runOrder: 1,
        }),
        this.createToolkitStage({
          actionName: 'Security',
          command: 'deploy',
          stage: AcceleratorStage.SECURITY,
          runOrder: 1,
        }),
        this.createToolkitStage({
          actionName: 'Operations',
          command: 'deploy',
          stage: AcceleratorStage.OPERATIONS,
          runOrder: 1,
        }),
        this.createToolkitStage({
          actionName: 'Network_VPCs',
          command: 'deploy',
          stage: AcceleratorStage.NETWORK_VPC,
          runOrder: 2,
        }),
        this.createToolkitStage({
          actionName: 'Security_Resources',
          command: 'deploy',
          stage: AcceleratorStage.SECURITY_RESOURCES,
          runOrder: 2,
        }),
        this.createToolkitStage({
          actionName: 'Identity_Center',
          command: 'deploy',
          stage: AcceleratorStage.IDENTITY_CENTER,
          runOrder: 2,
        }),
        this.createToolkitStage({
          actionName: 'Network_Associations',
          command: 'deploy',
          stage: AcceleratorStage.NETWORK_ASSOCIATIONS,
          runOrder: 3,
        }),
        this.createToolkitStage({
          actionName: 'Customizations',
          command: 'deploy',
          stage: AcceleratorStage.CUSTOMIZATIONS,
          runOrder: 4,
        }),
        this.createToolkitStage({
          actionName: 'Finalize',
          command: 'deploy',
          stage: AcceleratorStage.FINALIZE,
          runOrder: 5,
        }),
      ],
    });

    // Add ASEA Import Resources
    if (enableAseaMigration) {
      this.pipeline.addStage({
        stageName: 'PostImportAseaResources',
        actions: [
          this.createToolkitStage({
            actionName: 'Post_Import_Asea_Resources',
            command: `deploy`,
            stage: AcceleratorStage.POST_IMPORT_ASEA_RESOURCES,
          }),
        ],
      });
    }

    // Enable pipeline notification for commercial partition
    this.enablePipelineNotification();
  }

  /**
   * Add review stage based on parameter
   */
  private addReviewStage() {
    if (this.props.enableApprovalStage) {
      const notificationTopic = new cdk.aws_sns.Topic(this, 'ManualApprovalActionTopic', {
        topicName:
          (this.props.qualifier ? this.props.qualifier : this.props.prefixes.snsTopicName) + '-pipeline-review-topic',
        displayName:
          (this.props.qualifier ? this.props.qualifier : this.props.prefixes.snsTopicName) + '-pipeline-review-topic',
        masterKey: this.installerKey,
      });

      let notifyEmails: string[] | undefined = undefined;

      if (notificationTopic) {
        if (this.props.approvalStageNotifyEmailList) {
          notifyEmails = this.props.approvalStageNotifyEmailList.split(',');
        }
      }

      this.pipeline.addStage({
        stageName: 'Review',
        actions: [
          this.createToolkitStage({ actionName: 'Diff', command: 'diff', runOrder: 1 }),
          new codepipeline_actions.ManualApprovalAction({
            actionName: 'Approve',
            runOrder: 2,
            additionalInformation: 'See previous stage (Diff) for changes.',
            notificationTopic,
            notifyEmails,
          }),
        ],
      });
    }
  }

  private createToolkitStage(stageProps: {
    actionName: string;
    command: string;
    stage?: string;
    runOrder?: number;
  }): codepipeline_actions.CodeBuildAction {
    let cdkOptions;
    if (
      stageProps.command === AcceleratorToolkitCommand.BOOTSTRAP.toString() ||
      stageProps.command === AcceleratorToolkitCommand.DIFF.toString()
    ) {
      cdkOptions = stageProps.command;
    } else {
      cdkOptions = `${stageProps.command} --stage ${stageProps.stage}`;
    }

    const environmentVariables: {
      [name: string]: cdk.aws_codebuild.BuildEnvironmentVariable;
    } = {
      CDK_OPTIONS: {
        type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        value: cdkOptions,
      },
      CONFIG_COMMIT_ID: {
        type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        value: this.props.configRepositoryLocation === 's3' ? '#{Config-Vars.VersionId}' : '#{Config-Vars.CommitId}',
      },
    };

    if (stageProps.stage) {
      environmentVariables['ACCELERATOR_STAGE'] = {
        type: codebuild.BuildEnvironmentVariableType.PLAINTEXT,
        value: stageProps.stage ?? '',
      };
    }

    return new codepipeline_actions.CodeBuildAction({
      actionName: stageProps.actionName,
      runOrder: stageProps.runOrder,
      project: this.toolkitProject,
      input: this.buildOutput,
      extraInputs: [this.configRepoArtifact],
      role: this.pipelineRole,
      environmentVariables,
    });
  }

  /**
   * Enable pipeline notification for commercial partition and supported regions
   */
  private enablePipelineNotification() {
    if (this.props.enableSingleAccountMode) {
      return;
    }

    // We can Enable pipeline notification only for regions with AWS CodeStar being available
    if (this.props.awsCodeStarSupportedRegions.includes(cdk.Stack.of(this).region)) {
      const codeStarNotificationsRole = new ServiceLinkedRole(this, 'AWSServiceRoleForCodeStarNotifications', {
        environmentEncryptionKmsKey: this.installerKey,
        cloudWatchLogKmsKey: this.installerKey,
        // specifying this as it will be overwritten with global retention in logging stack
        cloudWatchLogRetentionInDays: 7,
        awsServiceName: 'codestar-notifications.amazonaws.com',
        description: 'Allows AWS CodeStar Notifications to access Amazon CloudWatch Events on your behalf',
        roleName: 'AWSServiceRoleForCodeStarNotifications',
      });

      this.pipeline.node.addDependency(codeStarNotificationsRole);

      const acceleratorStatusTopic = new cdk.aws_sns.Topic(this, 'AcceleratorStatusTopic', {
        topicName:
          (this.props.qualifier ? this.props.qualifier : this.props.prefixes.snsTopicName) + '-pipeline-status-topic',
        displayName:
          (this.props.qualifier ? this.props.qualifier : this.props.prefixes.snsTopicName) + '-pipeline-status-topic',
        masterKey: this.installerKey,
      });

      acceleratorStatusTopic.grantPublish(this.pipeline.role);

      this.pipeline.notifyOn('AcceleratorPipelineStatusNotification', acceleratorStatusTopic, {
        events: [
          cdk.aws_codepipeline.PipelineNotificationEvents.MANUAL_APPROVAL_FAILED,
          cdk.aws_codepipeline.PipelineNotificationEvents.MANUAL_APPROVAL_NEEDED,
          cdk.aws_codepipeline.PipelineNotificationEvents.MANUAL_APPROVAL_SUCCEEDED,
          cdk.aws_codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_CANCELED,
          cdk.aws_codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_FAILED,
          cdk.aws_codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_RESUMED,
          cdk.aws_codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_STARTED,
          cdk.aws_codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_SUCCEEDED,
          cdk.aws_codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_SUPERSEDED,
        ],
      });

      // Pipeline failure status topic and alarm
      const acceleratorFailedStatusTopic = new cdk.aws_sns.Topic(this, 'AcceleratorFailedStatusTopic', {
        topicName:
          (this.props.qualifier ? this.props.qualifier : this.props.prefixes.snsTopicName) +
          '-pipeline-failed-status-topic',
        displayName:
          (this.props.qualifier ? this.props.qualifier : this.props.prefixes.snsTopicName) +
          '-pipeline-failed-status-topic',
        masterKey: this.installerKey,
      });

      acceleratorFailedStatusTopic.grantPublish(this.pipeline.role);

      this.pipeline.notifyOn('AcceleratorPipelineFailureNotification', acceleratorFailedStatusTopic, {
        events: [cdk.aws_codepipeline.PipelineNotificationEvents.PIPELINE_EXECUTION_FAILED],
      });

      acceleratorFailedStatusTopic
        .metricNumberOfMessagesPublished()
        .createAlarm(this, 'AcceleratorPipelineFailureAlarm', {
          threshold: 1,
          evaluationPeriods: 1,
          datapointsToAlarm: 1,
          treatMissingData: cdk.aws_cloudwatch.TreatMissingData.NOT_BREACHING,
          alarmName: this.props.qualifier
            ? this.props.qualifier + '-pipeline-failed-alarm'
            : `${this.props.prefixes.accelerator}FailedAlarm`,
          alarmDescription: 'AWS Accelerator pipeline failure alarm, created by accelerator',
        });
    }
  }

  /**
   * Returns a codecommit configuration repository
   */
  private getCodeCommitConfigRepository(branchName: string) {
    let configRepository: cdk.aws_codecommit.IRepository | Repository;

    if (this.props.useExistingConfigRepo) {
      configRepository = cdk.aws_codecommit.Repository.fromRepositoryName(
        this,
        'ConfigRepository',
        this.props.configRepositoryName,
      );
    } else {
      configRepository = new config_repository.CodeCommitConfigRepository(this, 'ConfigRepository', {
        repositoryName: this.props.configRepositoryName,
        repositoryBranchName: branchName,
        description:
          'AWS Accelerator configuration repository, created and initialized with default config file by pipeline',
        managementAccountEmail: this.props.managementAccountEmail,
        logArchiveAccountEmail: this.props.logArchiveAccountEmail,
        auditAccountEmail: this.props.auditAccountEmail,
        controlTowerEnabled: this.props.controlTowerEnabled,
        controlTowerLandingZoneConfig: this.controlTowerLandingZoneConfig,
        enableSingleAccountMode: this.props.enableSingleAccountMode,
      }).getRepository();

      const cfnRepository = configRepository.node.defaultChild as codecommit.CfnRepository;
      cfnRepository.applyRemovalPolicy(cdk.RemovalPolicy.RETAIN, { applyToUpdateReplacePolicy: true });
    }
    return configRepository;
  }
  /**
   * Returns an S3 configuration repository
   */
  private getS3ConfigRepository() {
    const configRepository = new config_repository.S3ConfigRepository(this, 'ConfigRepository', {
      configBucketName: this.configBucketName,
      description:
        'AWS Accelerator configuration repository bucket, created and initialized with default config file by pipeline',
      managementAccountEmail: this.props.managementAccountEmail,
      logArchiveAccountEmail: this.props.logArchiveAccountEmail,
      auditAccountEmail: this.props.auditAccountEmail,
      controlTowerEnabled: this.props.controlTowerEnabled,
      controlTowerLandingZoneConfig: this.controlTowerLandingZoneConfig,
      enableSingleAccountMode: this.props.enableSingleAccountMode,
      installerKey: this.installerKey,
      serverAccessLogsBucketName: cdk.aws_ssm.StringParameter.valueForStringParameter(
        this,
        this.serverAccessLogsBucketNameSsmParam,
      ),
    }).getRepository();
    return configRepository;
  }

  /**
   * Function to construct default AWS Control Tower Landing Zone configuration
   * @returns controlTowerLandingZoneConfig {@link ControlTowerLandingZoneConfig} | undefined
   */
  private getControlTowerLandingZoneConfiguration(): ControlTowerLandingZoneConfig | undefined {
    const controlTowerEnabled = this.props.controlTowerEnabled.toLocaleLowerCase() === 'yes';

    if (!controlTowerEnabled && this.props.landingZoneIdentifier) {
      throw new Error(
        `It is not possible to deploy Accelerator when there is an existing AWS Control Tower and the ControlTowerEnabled parameter of the Accelerator installer stack is set to "No".`,
      );
    }

    if (!controlTowerEnabled) {
      return undefined;
    }

    // The CT configuration object should not be set if CT is already configured - this prevents overwriting the existing CT LZ configuration
    if (this.props.landingZoneIdentifier) {
      return undefined;
    }

    return {
      version: CONTROL_TOWER_LANDING_ZONE_VERSION,
      logging: {
        loggingBucketRetentionDays: 365,
        accessLoggingBucketRetentionDays: 3650,
        organizationTrail: true,
      },
      security: { enableIdentityCenterAccess: true },
    };
  }
}
