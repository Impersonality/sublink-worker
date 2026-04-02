import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { ClashConfigBuilder } from '../src/builders/ClashConfigBuilder.js';

describe('Clash preserve mode', () => {
  it('should preserve custom Clash YAML and append new proxies only', async () => {
    const baseConfig = {
      __meta: {
        type: 'clash',
        mode: 'preserve',
        format: 'raw-yaml'
      },
      rawContent: `# DNS防泄露版本
# 节点信息
proxies:
  - {name: 直连, type: direct}

# 出站策略
proxy-groups:
  - {name: 🚀 默认代理, type: select, proxies: [直连]}

# 规则匹配
rules:
  - MATCH,🚀 默认代理

# 规则集
rule-anchor:
  domain: &domain {type: http, interval: 86400, behavior: domain, format: mrs}
rule-providers:
  google_domain: {<<: *domain, url: "https://example.com/google.mrs"}
`
    };

    const input = 'ss://YWVzLTEyOC1nY206dGVzdA@example.com:443#HK-Node-1';
    const builder = new ClashConfigBuilder(input, 'balanced', [], baseConfig, 'zh-CN', 'mihomo/1.0');
    const text = await builder.build();
    const parsed = yaml.load(text);

    expect(text).toContain('# DNS防泄露版本');
    expect(text).toContain('proxy-groups:\n  - {name: 🚀 默认代理, type: select, proxies: [直连]}');
    expect(text).toContain('google_domain: {<<: *domain, url: "https://example.com/google.mrs"}');
    expect(text).toContain('- {name: HK-Node-1');
    expect(text).not.toContain('🐟 漏网之鱼');
    expect(parsed.proxies.map(proxy => proxy.name)).toEqual(['直连', 'HK-Node-1']);
  });

  it('should add proxies section when preserve config has none', async () => {
    const baseConfig = {
      __meta: {
        type: 'clash',
        mode: 'preserve',
        format: 'raw-yaml'
      },
      rawContent: `# custom header
mixed-port: 7890
rules:
  - MATCH,DIRECT
`
    };

    const input = 'ss://YWVzLTEyOC1nY206dGVzdA@example.com:443#HK-Node-1';
    const builder = new ClashConfigBuilder(input, 'minimal', [], baseConfig, 'zh-CN', 'mihomo/1.0');
    const text = await builder.build();
    const parsed = yaml.load(text);

    expect(text).toContain('# custom header');
    expect(text).toContain('proxies:\n  - {name: HK-Node-1');
    expect(parsed.proxies).toHaveLength(1);
    expect(parsed.proxies[0].name).toBe('HK-Node-1');
    expect(parsed.rules).toEqual(['MATCH,DIRECT']);
  });
});
