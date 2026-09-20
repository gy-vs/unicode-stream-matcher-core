import {it} from 'vitest';
it('executor reject handled synchronously', async () => {
  let calls = 0;
  const source: AsyncIterable<number> = {
    [Symbol.asyncIterator]() {
      return {
        next: () => new Promise<IteratorResult<number>>((resolve, reject) => {
          calls++;
          if (calls === 1) resolve({value: 1, done: false});
          else reject(new Error('boom'));
        }),
      };
    },
  };
  const it2 = source[Symbol.asyncIterator]();
  const a = await it2.next();
  const b = it2.next();
  const handled = await b.then(() => 'ok', (e) => 'caught:' + e.message);
  if (handled !== 'caught:boom') throw new Error('not handled');
});
