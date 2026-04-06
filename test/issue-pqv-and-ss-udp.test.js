import { describe, it, expect } from 'vitest';
import yaml from 'js-yaml';
import { parseVless } from '../src/parsers/protocols/vlessParser.js';
import { ClashConfigBuilder } from '../src/builders/ClashConfigBuilder.js';

describe('VLESS pqv and SS UDP handling', () => {
    it('should parse pqv from VLESS URL and emit it in Clash reality-opts', async () => {
        const pqv = 'test-pqv-value';
        const url = `vless://test-uuid@example.com:443?security=reality&sni=example.com&fp=firefox&pbk=test-public-key&sid=abcd1234&pqv=${encodeURIComponent(pqv)}#RealityNode`;

        const parsed = parseVless(url);

        expect(parsed.tls?.utls?.fingerprint).toBe('firefox');
        expect(parsed.tls?.reality?.mldsa65_verify).toBe(pqv);

        const builder = new ClashConfigBuilder(url, 'minimal', [], null, 'zh-CN', 'mihomo/1.0');
        const yamlText = await builder.build();
        const built = yaml.load(yamlText);
        const proxy = built.proxies.find((item) => item.name === 'RealityNode');

        expect(proxy).toBeDefined();
        expect(proxy['reality-opts']).toBeDefined();
        expect(proxy['reality-opts']['mldsa65-verify']).toBe(pqv);
    });

    it('should preserve udp=true from SS URL query when converting to Clash', async () => {
        const ssUrl = 'ss://YWVzLTEyOC1nY206dGVzdA@example.com:8388/?udp=true#SS-UDP';

        const builder = new ClashConfigBuilder(ssUrl, 'minimal', [], null, 'zh-CN', 'mihomo/1.0');
        const yamlText = await builder.build();
        const built = yaml.load(yamlText);
        const proxy = built.proxies.find((item) => item.name === 'SS-UDP');

        expect(proxy).toBeDefined();
        expect(proxy.type).toBe('ss');
        expect(proxy.udp).toBe(true);
    });

    it('should preserve mldsa65-verify when round-tripping Clash YAML', async () => {
        const input = `proxies:
  - name: VLESS-PQV
    type: vless
    server: example.com
    port: 443
    uuid: test-uuid
    tls: true
    servername: example.com
    client-fingerprint: chrome
    reality-opts:
      public-key: test-public-key
      short-id: abcd1234
      mldsa65-verify: test-pqv-value`;

        const builder = new ClashConfigBuilder(input, 'minimal', [], null, 'zh-CN', 'mihomo/1.0');
        const yamlText = await builder.build();
        const built = yaml.load(yamlText);
        const proxy = built.proxies.find((item) => item.name === 'VLESS-PQV');

        expect(proxy).toBeDefined();
        expect(proxy['reality-opts']).toBeDefined();
        expect(proxy['reality-opts']['mldsa65-verify']).toBe('test-pqv-value');
    });
});
