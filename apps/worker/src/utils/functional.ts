// Copyright (C) 2025 Keygraph, Inc.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License version 3
// as published by the Free Software Foundation.

/**
 * Functional Programming Utilities
 *
 * Generic functional composition patterns for async operations.
 */

type PipelineFunction = (x: never) => unknown;

/**
 * Async pipeline that passes result through a series of functions.
 * Clearer than reduce-based pipe and easier to debug.
 */
export async function asyncPipe<TResult>(
  initial: unknown,
  ...fns: PipelineFunction[]
): Promise<TResult> {
  let result = initial;
  for (const fn of fns) {
    result = await fn(result as never);
  }
  return result as TResult;
}
