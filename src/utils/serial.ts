/** Serialize state mutations; a rejected operation never poisons the queue. */
export function createSerialQueue() {
  let tail: Promise<unknown> = Promise.resolve();
  return function run<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = tail.then(operation);
    tail = result.catch(() => {});
    return result;
  };
}
