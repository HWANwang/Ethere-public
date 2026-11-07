import test from 'node:test';
import assert from 'node:assert/strict';
import { stopOwnedProcessTree } from '../server/owned-process-tree.mjs';

test('Windows stops only the given supervisor-owned process tree', async () => {
  const calls = [];
  await stopOwnedProcessTree({ pid: 1234, exitCode: null, signalCode: null }, {
    platform: 'win32',
    run: async (...args) => { calls.push(args); },
  });
  assert.deepEqual(calls, [['taskkill.exe', ['/PID', '1234', '/T', '/F'], { windowsHide: true, timeout: 10_000 }]]);
});

test('Windows does not mask failure while the child is still alive', async () => {
  await assert.rejects(stopOwnedProcessTree({ pid: 1234, exitCode: null, signalCode: null }, {
    platform: 'win32', run: async () => { throw new Error('access denied'); },
  }), /access denied/);
});

test('Windows never targets a PID after its owned child has exited', async () => {
  await stopOwnedProcessTree({ pid: 1234, exitCode: 0, signalCode: null }, {
    platform: 'win32', run: async () => { throw new Error('must not run taskkill'); },
  });
});

test('other platforms stop the owned direct child without taskkill', async () => {
  let killed = false;
  await stopOwnedProcessTree({ pid: 1234, kill: () => { killed = true; } }, {
    platform: 'linux', run: async () => { throw new Error('unexpected'); },
  });
  assert.equal(killed, true);
});
