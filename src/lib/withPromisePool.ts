import PromisePool from '@supercharge/promise-pool';

export async function withPromisePool(size, items, func) {
  return await PromisePool.for(items)
    .withConcurrency(size)
    .handleError(async (error) => {
      // This will cause the pool to stop creating instances after the first error
      throw error;
    })
    .process(func);
}
