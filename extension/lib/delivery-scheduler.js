// A FIFO slot is held for one network batch, never for storage/capture work.
export function createDeliveryScheduler(limit = 2) {
  let active = 0;
  const waiting = [];
  function pump() {
    while (active < limit && waiting.length) {
      const { task, resolve, reject } = waiting.shift();
      active += 1;
      Promise.resolve().then(task).then(resolve, reject).finally(() => {
        active -= 1;
        pump();
      });
    }
  }
  return {
    run(task) {
      return new Promise((resolve, reject) => {
        waiting.push({ task, resolve, reject });
        pump();
      });
    },
  };
}
