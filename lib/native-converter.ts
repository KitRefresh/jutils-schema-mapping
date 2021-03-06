import { NativeMappingRule } from '../types/native-mapping-rule.model';
import { Pipe } from '../types/pipe.model';
import { ProcessOperation, PullOperation, PushOperation } from '../types/rule-operation.model';
import BuiltInPipes from './builtin-pipes';
import { pipebuilder } from './helpers/pipebuilder';
import { pullData } from './helpers/pulldata';
import { pushData } from './helpers/pushdata';
import { curry } from './utils/curry';
import { Logger, LogSeverity } from './utils/logger';
import { OperationTypeIndicator } from './utils/operation-type-indicator';
import { replaceAt } from './utils/replace-at';

const logger = new Logger('[Converter]', LogSeverity.WARNING);

const FALLBACK_VALUE = null;

export function naitiveConverter(srcData: any, rules: NativeMappingRule[], customizedPipes: {[pipeName: string]: Pipe}): any {
  if (!rules || rules.length === 0) {
    logger.warn('Empty rules');
    return FALLBACK_VALUE;
  }

  const entryRules = rules.filter(x => x.isEntry);

  if (entryRules.length !== 1) {
    logger.warn('No entry rule or multiple entry rules.');
    return FALLBACK_VALUE;
  }

  const ruleByName = new Map<string, NativeMappingRule>();
  rules.forEach((rule) => {
    ruleByName.set(rule.name, rule);
  })

  const entryRuleName = entryRules[0].name;
  const result = applyMappingRule(entryRuleName, ruleByName, customizedPipes, srcData);

  return result;
}

function applyMappingRule(ruleName: string, relatedRules: Map<string, NativeMappingRule>, customizedPipes: {[pipeName: string]: Pipe}, srcData: any): any {
  if (!relatedRules.has(ruleName)) {
    logger.warn(`Cannot find given rule: ${ruleName}.`);
    return FALLBACK_VALUE;
  }

  let mappingRule = relatedRules.get(ruleName);
  let result: any;

  for (let pipeline of mappingRule.pipelines) {
    logger.debug('Execute rules: ', pipeline);

    // Each rule should at least have two segments: pull + push.
    if (pipeline.length < 2) {
      logger.error('Invalid mapping rule!');
      continue;
    }

    let streams: any[] = [];

    // Apply operations.
    for (let opt of pipeline) {

      // PULL
      if (OperationTypeIndicator.isPullOperation(opt)) {
        streams = (opt as PullOperation).sources
          .map((sourcePath) => pullData(srcData, sourcePath));

        logger.debug('$ - Anchor to: ', streams);
      }

      // PUSH
      else if (OperationTypeIndicator.isPushOpertaion(opt)) {
        /* 1 - decide which part of data to write. */
        const { target, indexed, selectedIndex } = opt as PushOperation;
        let dataToWrite = indexed ? streams[selectedIndex] : streams;

        /* 2 - decide if we should write data iteratively. (one to multiple) */
        const { iterative, iterateKey } = opt as PushOperation;

        if (iterative) {
          // Assuming the 'arr' field in 'result' is already an obj array with length = N,
          // all of those N elements in result.arr will be inserted by `dataToWrite` at `iterateKey`
          let host = pullData(result, replaceAt(target, 0, '$'));
          
          if (!Array.isArray(host)) {
            // write failed.
            logger.error('Invalid selected target. Iterative pusher required an array target.');
            continue;
          }

          (host as any[]).forEach(element => {
            element[iterateKey] = dataToWrite;
          });

        } else {
          result = pushData(result, target, dataToWrite);
        }

        logger.debug('T - Wrote to: ', result, 'with', dataToWrite);
      }

      // PROCESS
      else if (OperationTypeIndicator.isProcessOperation(opt)) {

        /* 1 - Init 'fn' based on pipeName. */
        let fn: Function;
        const { isHyperRule, pipeName, pipeParameters } = (opt as ProcessOperation);

        if (isHyperRule) {
          // DFS to transfrom recursively (ignore parameters).
          fn = curry(applyMappingRule, pipeName, relatedRules, customizedPipes);

        } else if (customizedPipes && pipeName in customizedPipes) {
          // Custmized pipes has higher priority than built-in pipes.
          fn = pipebuilder(customizedPipes[pipeName], ...pipeParameters);

        } else if (pipeName in BuiltInPipes) {
          // Invoke built-in pipes with params.
          fn = pipebuilder(BuiltInPipes[pipeName], ...pipeParameters);

        } else {
          logger.error('Cannot find given pipe: ', pipeName);
          continue;
        }

        /* 2 - Init input data source */
        let inputData: any[];
        const { sliced, selectedIndex } = (opt as ProcessOperation);

        if (sliced) {
          inputData = streams.slice(selectedIndex, selectedIndex + 1);
        } else {
          inputData = streams;
        }

        /* 3 - Execute transform process. */
        let outputData: any;
        const { iterative } = (opt as ProcessOperation);

        if (iterative) {
          // HACK: iterative mode only transform the first stream. Ignore other streams.
          inputData = inputData[0];

           // Validate selectedData is iterable.
           if (!Array.isArray(inputData)) {
            logger.error('Non-iterable data stream. Please check your rule!', opt);
            continue;
          }
          outputData = (inputData as any[]).map(x => fn(x));

        } else {
          // Expand input data as 1~N parameters.
          outputData = fn(...inputData);
        }

        /* 4 - Write output result to target. */
        if (sliced) {
          // Only modify ith stream under indexed mode.
          streams[selectedIndex] = outputData;
        } else {

          // Otherwise, rewrite whole stream.
          streams = [ outputData ];
        }

        logger.log('F - Transformed data stream: ', streams);
      }

      // Unhandled cases.
      else {
        logger.warn('Cannot handle operation: ', opt);
        continue;
      }

    } // end of opt loop

  } // end of pipeline loop

  return result;
}
