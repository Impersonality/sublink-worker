import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { createTranslator } from '../src/i18n/index.js';
import { ClashConfigBuilder } from '../src/builders/ClashConfigBuilder.js';
import { sanitizeClashProxyGroups } from '../src/builders/helpers/clashConfigUtils.js';

// Create translator for tests
const t = createTranslator('zh-CN');

describe('Clash Builder Tests', () => {
  it('should clean up proxy-groups and remove non-existent proxies', async () => {
    const input = `
proxies:
  - name: Valid-SS
    type: ss
    server: example.com
    port: 443
    cipher: aes-128-gcm
    password: test
proxy-groups:
  - name: 自定义选择
    type: select
    proxies:
      - DIRECT
      - REJECT
      - Valid-SS
      - NotExist
    `;

    const builder = new ClashConfigBuilder(input, 'minimal', [], null, 'zh-CN', 'test-agent');
    const yamlText = await builder.build();
    const built = yaml.load(yamlText);

    const grp = (built['proxy-groups'] || []).find(g => g && g.name === '自定义选择');
    expect(grp).toBeDefined();

    const expected = ['DIRECT', 'REJECT', 'Valid-SS'];
    const actual = grp.proxies || [];

    expect(actual).toEqual(expected);
  });

  it('should reference user-defined proxy-providers in generated proxy-groups', async () => {
    const input = `
proxy-providers:
  my-provider:
    type: http
    url: https://example.com/sub
    path: ./my.yaml
    interval: 3600

proxies:
  - name: local
    type: ss
    server: 127.0.0.1
    port: 1080
    cipher: aes-256-gcm
    password: test
`;

    const builder = new ClashConfigBuilder(input, 'minimal', [], null, 'zh-CN', 'test-agent');
    const yamlText = await builder.build();
    const built = yaml.load(yamlText);

    const nodeSelect = (built['proxy-groups'] || []).find(g => g && g.name === '🚀 节点选择');
    expect(nodeSelect).toBeDefined();
    expect(nodeSelect.use).toContain('my-provider');
  });

  it('sanitizeClashProxyGroups should not remove provider node references when group uses providers', () => {
    const config = {
      proxies: [],
      'proxy-groups': [
        {
          name: 'Custom Group',
          type: 'select',
          use: ['my-provider'],
          proxies: ['node-from-provider']
        }
      ]
    };

    sanitizeClashProxyGroups(config);

    const grp = (config['proxy-groups'] || [])[0];
    expect(grp).toBeDefined();
    expect(grp.proxies).toContain('node-from-provider');
  });

  it('should route Private/Non-China to Node Select and CN to DIRECT without extra groups', async () => {
    const input = `
ss://YWVzLTEyOC1nY206dGVzdA@example.com:443#HK-Node-1
ss://YWVzLTEyOC1nY206dGVzdA@example.com:444#US-Node-1
    `;

    const builder = new ClashConfigBuilder(input, 'minimal', [], null, 'zh-CN', 'test-agent');
    const yamlText = await builder.build();
    const built = yaml.load(yamlText);

    const privateName = t('outboundNames.Private');
    const cnName = t('outboundNames.Location:CN');
    const nonChinaName = t('outboundNames.Non-China');
    const nodeSelectName = t('outboundNames.Node Select');
    const fallbackName = t('outboundNames.Fall Back');

    expect((built['proxy-groups'] || []).find(g => g && g.name === privateName)).toBeUndefined();
    expect((built['proxy-groups'] || []).find(g => g && g.name === cnName)).toBeUndefined();
    expect((built['proxy-groups'] || []).find(g => g && g.name === nonChinaName)).toBeUndefined();

    expect(built.rules).toContain(`RULE-SET,private,${nodeSelectName}`);
    expect(built.rules).toContain('RULE-SET,geolocation-cn,DIRECT');
    expect(built.rules).toContain(`RULE-SET,geolocation-!cn,${nodeSelectName}`);

    const fallbackGroup = (built['proxy-groups'] || []).at(-1);
    expect(fallbackGroup?.name).toBe(fallbackName);
  });

  it('should emit richer mihomo defaults without folding long URLs', async () => {
    const input = `
ss://YWVzLTEyOC1nY206dGVzdA@example.com:443#HK-Node-1
    `;

    const builder = new ClashConfigBuilder(input, 'minimal', [], null, 'zh-CN', 'mihomo/1.0');
    const yamlText = await builder.build();
    const built = yaml.load(yamlText);

    expect(built['mixed-port']).toBe(7890);
    expect(built['bind-address']).toBe('*');
    expect(built['global-client-fingerprint']).toBe('chrome');
    expect(built.profile).toMatchObject({
      'store-selected': true,
      'store-fake-ip': true
    });
    expect(built.sniffer).toMatchObject({
      enable: true
    });
    expect(built.tun).toMatchObject({
      enable: true,
      'auto-route': true,
      'strict-route': true
    });
    expect(built.dns).toMatchObject({
      'cache-algorithm': 'arc',
      'fake-ip-range': '28.0.0.1/8',
      'fake-ip-filter-mode': 'blacklist'
    });
    expect(yamlText).not.toContain('>-');
    expect(yamlText).toContain('# 节点信息');
    expect(yamlText).toContain('# 全局配置');
    expect(yamlText).toContain('- {name: HK-Node-1');
    expect(yamlText).toContain('name: 🔁 故障转移, type: fallback');
    expect(yamlText).toContain('name: 🐟 漏网之鱼, type: select, proxies: [🚀 节点选择, 🔁 故障转移, ⚡ 自动选择, DIRECT]');
  });

  it('should include richer domain rules in balanced preset', async () => {
    const input = `
ss://YWVzLTEyOC1nY206dGVzdA@example.com:443#HK-Node-1
    `;

    const builder = new ClashConfigBuilder(input, 'balanced', [], null, 'zh-CN', 'mihomo/1.0');
    const yamlText = await builder.build();
    const built = yaml.load(yamlText);

    expect(built['rule-providers'].private).toBeDefined();
    expect(built['rule-providers'].telegram).toBeDefined();
    expect(built['rule-providers'].twitch).toBeDefined();
    expect(built.rules).toContain(`RULE-SET,private,${t('outboundNames.Node Select')}`);
    expect(built.rules).toContain(`RULE-SET,telegram,${t('outboundNames.Telegram')}`);
    expect(built.rules).toContain(`RULE-SET,twitch,${t('outboundNames.Youtube')}`);
    expect(yamlText).toContain('rule-anchor:');
    expect(yamlText).toContain('domain: &domain {type: http, interval: 86400, behavior: domain, format: mrs}');
    expect(yamlText).toContain('google: {<<: *domain');
  });
});
