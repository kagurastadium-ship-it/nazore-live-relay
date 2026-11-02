import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRelay } from './relay.mjs';

class Socket extends EventEmitter {
  readyState = 1;
  bufferedAmount = 0;
  messages = [];
  send(data) { this.messages.push(JSON.parse(data)); }
  close() { this.readyState = 3; this.emit('close'); }
  receive(data) { this.emit('message', JSON.stringify(data)); }
}

class Connection extends EventEmitter {
  async connect() {}
  async disconnect() {}
}

function setup() {
  let now = 1800000000000;
  let starts = 0;
  const connections = new Map();
  const relay = createRelay({
    now: () => now,
    createConnection: id => {
      starts++;
      const connection = new Connection();
      connections.set(id, connection);
      return connection;
    }
  });
  return {
    relay, connections,
    now: () => now,
    advance: ms => { now += ms; },
    starts: () => starts,
    join: (id, mode, sub) => {
      const socket = new Socket();
      relay.attach(socket);
      socket.receive({
        type: 'subscribe',
        tiktokId: id,
        subscriptionId: sub,
        ...(mode ? {commentMode: mode} : {})
      });
      return socket;
    },
    emit: (id, content, eventId, timestamp = now) => {
      connections.get(id).emit('chat', {
        content, msgId: eventId, timestamp
      });
    }
  };
}

const chats = socket =>
  socket.messages.filter(m => m.type === 'chat').map(m => m.comment);

const flush = () => new Promise(resolve => setImmediate(resolve));

test('漢字分解とナゾレを同時購読して回答を分離', async () => {
  const f = setup();
  try {
    const kanji = f.join('@alice', undefined, 'kanji');
    const words = f.join('alice', 'words', 'nazore');
    await flush();

    assert.equal(f.starts(), 1);

    f.emit('alice', 'メロン', 'ev1');
    f.emit('alice', '答えはメロン', 'ev2');
    f.emit('alice', '木', 'ev3');

    assert.deepEqual(chats(kanji), ['木']);
    assert.deepEqual(chats(words), [
      'メロン', '答えはメロン', '木'
    ]);
  } finally {
    f.relay.close();
  }
});

test('重複・過去コメント・別配信者を除外', async () => {
  const f = setup();
  try {
    const alice = f.join('alice', 'words', 'sub-a');
    const bob = f.join('bob', 'words', 'sub-b');
    await flush();

    f.emit('alice', 'メロン', 'same-id');
    f.emit('alice', 'メロン', 'same-id');
    assert.deepEqual(chats(alice), ['メロン']);
    assert.deepEqual(chats(bob), []);

    f.advance(1000);
    alice.receive({type:'round', subscriptionId:'sub-a'});
    f.emit('alice', 'ぶどう', 'old', f.now() - 500);
    f.emit('alice', 'りんご', 'new', f.now());

    assert.deepEqual(chats(alice), ['メロン', 'りんご']);
    assert.deepEqual(chats(bob), []);
  } finally {
    f.relay.close();
  }
});

test('無効モード・長文・制御文字を拒否', async () => {
  const f = setup();
  try {
    const invalid = f.join('alice', 'unknown', 'bad');
    assert.equal(invalid.messages.at(-1).terminal, true);

    const words = f.join('alice', 'words', 'good');
    await flush();

    f.emit('alice', 'メロン見つけた！', 'valid');
    f.emit('alice', 'あ'.repeat(81), 'too-long');
    f.emit('alice', 'メ\nロン', 'control');

    assert.deepEqual(chats(words), ['メロン見つけた！']);
    assert.deepEqual(chats(invalid), []);
  } finally {
    f.relay.close();
  }
});