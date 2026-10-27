'use strict';

/**
 * 连接配置持久化：userData/config.json
 * SecretKey 做 base64 轻混淆落盘（非明文；本机隔离，不随仓库分发）。
 */

const path = require('node:path');
const fs = require('node:fs');

const FIELDS = ['endpoint', 'region', 'accessKey', 'secretKey', 'bucket', 'prefix', 'verifySSL'];

function obfuscate(s) {
  return Buffer.from(String(s), 'utf8').toString('base64');
}

function deobfuscate(s) {
  try {
    return Buffer.from(String(s), 'base64').toString('utf8');
  } catch {
    return '';
  }
}

class ConfigStore {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'config.json');
    this.data = null;
  }

  get isEmpty() {
    return !this.data || !this.data.endpoint || !this.data.bucket;
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = {
        endpoint: raw.endpoint || '',
        region: raw.region || '',
        bucket: raw.bucket || '',
        prefix: raw.prefix || '',
        verifySSL: raw.verifySSL !== false,
        accessKey: raw.accessKey ? deobfuscate(raw.accessKey) : '',
        secretKey: raw.secretKey ? deobfuscate(raw.secretKey) : '',
      };
    } catch {
      this.data = null;
    }
    return this.data;
  }

  save(partial) {
    const prev = this.data || {};
    const next = { ...prev };
    for (const f of FIELDS) {
      if (partial && partial[f] !== undefined) next[f] = partial[f];
    }
    if (next.verifySSL === undefined) next.verifySSL = true;
    this.data = next;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const payload = {
      endpoint: next.endpoint,
      region: next.region,
      bucket: next.bucket,
      prefix: next.prefix || '',
      verifySSL: next.verifySSL !== false,
      accessKey: obfuscate(next.accessKey || ''),
      secretKey: obfuscate(next.secretKey || ''),
    };
    fs.writeFileSync(this.file, JSON.stringify(payload, null, 2), 'utf8');
    return this.data;
  }

  clear() {
    this.data = null;
    try {
      fs.rmSync(this.file, { force: true });
    } catch { /* 忽略 */ }
  }
}

module.exports = { ConfigStore };
