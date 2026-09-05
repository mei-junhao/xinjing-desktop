'use strict';

const assert = require('assert');
const sanitizer = require('../app/js/pii-sanitizer.js');

function test(name, fn) {
  try {
    fn();
    process.stdout.write('PASS ' + name + '\n');
  } catch (error) {
    process.stderr.write('FAIL ' + name + ': ' + error.message + '\n');
    process.exitCode = 1;
  }
}

test('replaces high-risk identifiers without retaining raw values', () => {
  const source = '患者姓名：李明，电话 13812345678，邮箱 li.ming@example.com，身份证 110101199001011234。';
  const result = sanitizer.sanitizeText(source);
  assert.strictEqual(result.ok, true);
  assert.ok(result.text.includes('[[PERSON_NAME_1]]'));
  assert.ok(result.text.includes('[[PHONE_1]]'));
  assert.ok(result.text.includes('[[EMAIL_1]]'));
  assert.ok(result.text.includes('[[ID_CARD_1]]'));
  assert.ok(!result.text.includes('13812345678'));
  assert.ok(!result.text.includes('li.ming@example.com'));
  assert.strictEqual(result.residual.length, 0);
});

test('keeps replacement stable across messages in one request', () => {
  const result = sanitizer.sanitizeMessages([
    { role: 'user', content: '来访者姓名：王芳，电话 13900001111' },
    { role: 'assistant', content: '请联系王芳（13900001111）确认时间。' },
  ]);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.messages[0].content.match(/\[\[PERSON_NAME_1\]\]/g).length, 1);
  assert.strictEqual(result.messages[1].content.includes('[[PERSON_NAME_1]]'), true);
  assert.strictEqual(result.messages[1].content.includes('[[PHONE_1]]'), true);
});

test('preserves message structure and sanitizes nested text', () => {
  const result = sanitizer.sanitizeMessages([{
    role: 'assistant',
    tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"phone":"13612345678"}' } }],
    content: [{ type: 'text', text: '地址：上海市静安区南京西路 100 号' }],
  }]);
  assert.strictEqual(result.ok, true);
  assert.strictEqual(result.messages[0].tool_calls[0].id, 'call_1');
  assert.strictEqual(result.messages[0].content[0].text.includes('[[ADDRESS_1]]'), true);
  assert.strictEqual(result.messages[0].tool_calls[0].function.arguments.includes('13612345678'), false);
});

test('fails closed for invalid message input', () => {
  const result = sanitizer.sanitizeMessages(null);
  assert.strictEqual(result.ok, false);
  assert.strictEqual(result.code, 'XJ_PII_SANITIZATION_FAILED');
});

test('replaces network identifiers', () => {
  const result = sanitizer.sanitizeText('设备地址 192.168.1.20，参考 https://example.test/path?a=1');
  assert.strictEqual(result.ok, true);
  assert.ok(result.text.includes('[[IP_ADDRESS_1]]'));
  assert.ok(result.text.includes('[[URL_1]]'));
  assert.ok(!result.text.includes('192.168.1.20'));
  assert.ok(!result.text.includes('https://example.test'));
});
