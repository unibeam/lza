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
  type DescribeChangeSetOutput,
  type FormatStream,
  formatDifferences,
  fullDiff,
  mangleLikeCloudFormation,
} from '@aws-cdk/cloudformation-diff';
import * as fs from 'fs';
import { createLogger } from './logger';

const logger = createLogger(['diff']);
/**
 * Pretty-prints the differences between two template states to the console.
 *
 * @param oldTemplate the old/current state of the stack.
 * @param newTemplate the new/target state of the stack.
 * @param strict      do not filter out AWS::CDK::Metadata
 * @param context     lines of context to use in arbitrary JSON diff
 * @param quiet       silences \'There were no differences\' messages
 *
 * @returns the count of differences that were rendered.
 */
export function printStackDiff(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  oldTemplate: any,
  newTemplate: string,
  strict: boolean,
  context: number,
  quiet: boolean,
  changeSet?: DescribeChangeSetOutput,
  stream?: FormatStream,
): number {
  let diff = fullDiff(readTemplate(oldTemplate), readTemplate(newTemplate));

  // detect and filter out mangled characters from the diff
  let filteredChangesCount = 0;
  if (diff.differenceCount && !strict) {
    const mangledNewTemplate = JSON.parse(mangleLikeCloudFormation(JSON.stringify(newTemplate)));
    const mangledDiff = fullDiff(oldTemplate, mangledNewTemplate, changeSet);
    filteredChangesCount = Math.max(0, diff.differenceCount - mangledDiff.differenceCount);
    if (filteredChangesCount > 0) {
      diff = mangledDiff;
    }
  }

  // filter out 'AWS::CDK::Metadata' resources from the template
  if (diff.resources && !strict) {
    diff.resources = diff.resources.filter(change => {
      if (!change) {
        return true;
      }
      if (change.newResourceType === 'AWS::CDK::Metadata') {
        return false;
      }
      if (change.oldResourceType === 'AWS::CDK::Metadata') {
        return false;
      }
      return true;
    });
  }

  // filter out 'AWS::CDK::Metadata' resources from the template
  if (diff.resources && !strict) {
    diff.resources = diff.resources.filter(change => {
      if (!change) {
        return true;
      }
      if (change.newResourceType === 'AWS::CDK::Metadata') {
        return false;
      }
      if (change.oldResourceType === 'AWS::CDK::Metadata') {
        return false;
      }
      return true;
    });
  }

  if (!diff.isEmpty) {
    formatDifferences(
      stream || process.stderr,
      diff,
      {
        ...logicalIdMapFromTemplate(oldTemplate),
        ...logicalIdMapFromTemplate(newTemplate),
      },
      context,
    );
  } else if (!quiet) {
    stream?.write('There were no differences');
  }

  return diff.differenceCount;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function logicalIdMapFromTemplate(template: any) {
  const ret: Record<string, string> = {};

  for (const [logicalId, resource] of Object.entries(template.Resources ?? {})) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const path = (resource as any)?.Metadata?.['aws:cdk:path'];
    if (path) {
      ret[logicalId] = path;
    }
  }
  return ret;
}

function readTemplate(input: string) {
  try {
    return JSON.parse(fs.readFileSync(input, { encoding: 'utf-8' }));
  } catch (e) {
    logger.error(`Error reading template: ${input}`);
    const fileContents = fs.readFileSync(input, { encoding: 'utf-8' });
    logger.error(`File Content: \n\n${fileContents}\n\n Exception: ${e}\n`);

    throw e;
  }
}
