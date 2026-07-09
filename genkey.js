/**
 * genkey.js — 心镜 XinJing 开发者出码工具
 * 用法：
 *   node genkey.js "客户邮箱或姓名"
 *   node genkey.js "张三" "备注（可选）"
 * 生成的码会输出到控制台，并追加到本地 keys.log（不进仓库，仅供你留存）。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { encodeKey } = require('./license-core');

const identity = process.argv[2];
const note = process.argv[3] || '';

if (!identity) {
  console.error('用法: node genkey.js "客户邮箱或姓名" ["备注"]');
  process.exit(1);
}

const key = encodeKey(identity);
const line = `${new Date().toISOString()}\t${identity}\t${key}\t${note}\n`;

const logPath = path.join(__dirname, 'keys.log');
fs.appendFileSync(logPath, line, 'utf8');

console.log('\n=== 心镜激活码 ===');
console.log('授权对象 :', identity);
console.log('激活码   :', key);
console.log('（已记录到 keys.log）\n');
