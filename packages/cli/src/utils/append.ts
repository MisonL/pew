/**
 * Array helpers for data-driven sizes.
 *
 * `target.push(...items)` and `Math.max(acc, ...items)` build a call argument
 * list, and V8 overflows the stack once that list passes roughly 125k
 * entries ("Maximum call stack size exceeded"). The inputs here come from
 * parsed log files and query results, so their length is unbounded — a large
 * enough source used to abort the whole source with an error that reads like
 * a parser bug.
 */

/** Append every item without building an argument list. */
export function appendAll<T>(target: T[], items: readonly T[]): T[] {
  for (const item of items) target.push(item);
  return target;
}

/** Largest value, or `initial` when `values` is empty. */
export function maxOf(values: readonly number[], initial: number): number {
  let max = initial;
  for (const value of values) if (value > max) max = value;
  return max;
}
