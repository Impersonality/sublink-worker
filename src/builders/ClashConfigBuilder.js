import yaml from 'js-yaml';
import { CLASH_CONFIG, generateRules, generateClashRuleSets, getOutbounds, PREDEFINED_RULE_SETS } from '../config/index.js';
import { BaseConfigBuilder } from './BaseConfigBuilder.js';
import { deepCopy, groupProxiesByCountry } from '../utils.js';
import { addProxyWithDedup } from './helpers/proxyHelpers.js';
import { buildSelectorMembers, buildNodeSelectMembers, uniqueNames } from './helpers/groupBuilder.js';
import { emitClashRules, sanitizeClashProxyGroups } from './helpers/clashConfigUtils.js';
import { normalizeGroupName, findGroupIndexByName } from './helpers/groupNameUtils.js';

/**
 * Check if the client supports MRS (Meta Rule Set) format
 * MRS is a binary format supported by Clash Meta/mihomo
 * Legacy Clash clients need YAML format instead
 * @param {string} userAgent - Client User-Agent string
 * @returns {boolean} - True if client supports MRS format
 */
function supportsMrsFormat(userAgent) {
    if (!userAgent) return true; // Default to mrs for unknown clients
    const ua = userAgent.toLowerCase();
    
    // Clients confirmed to support MRS format (Clash Meta/mihomo based)
    if (ua.includes('mihomo') || 
        ua.includes('meta') ||           // clash.meta, clashx meta, meta-for-android, etc.
        ua.includes('clash-verge') ||
        ua.includes('stash') ||
        ua.includes('verge')) {
        return true;
    }
    
    // Legacy clients that don't support MRS format
    if (ua.includes('merlin') ||
        ua.includes('clashforwindows') ||
        ua.includes('clashforandroid') ||
        ua.includes('clash/')) {         // 老版本Clash核心 (Clash/v1.x.x)
        return false;
    }
    
    // Default: use mrs for unknown clients (most modern clients support it)
    return true;
}

export class ClashConfigBuilder extends BaseConfigBuilder {
    constructor(inputString, selectedRules, customRules, baseConfig, lang, userAgent, groupByCountry = false, enableClashUI = false, externalController, externalUiDownloadUrl, includeAutoSelect = true) {
        let preserveRawConfig = null;
        let preserveParsedConfig = null;
        if (baseConfig?.__meta?.type === 'clash' && baseConfig?.__meta?.mode === 'preserve' && typeof baseConfig?.rawContent === 'string') {
            preserveRawConfig = baseConfig.rawContent;
            preserveParsedConfig = yaml.load(preserveRawConfig) || {};
            baseConfig = { proxies: [] };
        }
        if (!baseConfig) {
            baseConfig = CLASH_CONFIG;
        }
        super(inputString, baseConfig, lang, userAgent, groupByCountry, includeAutoSelect);
        this.selectedRules = selectedRules;
        this.customRules = customRules;
        this.countryGroupNames = [];
        this.manualGroupName = null;
        this.enableClashUI = enableClashUI;
        this.externalController = externalController;
        this.externalUiDownloadUrl = externalUiDownloadUrl;
        this.preserveMode = Boolean(preserveRawConfig);
        this.preserveRawConfig = preserveRawConfig;
        this.preserveParsedConfig = preserveParsedConfig;
        this.preserveAppendedProxies = [];
        this.preserveExistingProxyNames = new Set(
            Array.isArray(preserveParsedConfig?.proxies)
                ? preserveParsedConfig.proxies.map(proxy => proxy?.name).filter(Boolean)
                : []
        );
    }

    getHiddenRuleGroups() {
        return new Set(['Private', 'Location:CN', 'Non-China']);
    }

    renderInlineProxyLine(proxy) {
        const normalized = this.normalizeInlineObject('proxies', proxy);
        const rendered = yaml.dump([normalized], {
            flowLevel: 1,
            lineWidth: -1,
            noRefs: true
        }).trimEnd();
        return rendered.split('\n').map(line => `  ${line}`).join('\n');
    }

    mergePreserveRawConfig() {
        const raw = typeof this.preserveRawConfig === 'string' ? this.preserveRawConfig : '';
        if (this.preserveAppendedProxies.length === 0) {
            return raw;
        }

        const proxyLines = this.preserveAppendedProxies.map(proxy => this.renderInlineProxyLine(proxy)).join('\n');
        const lines = raw.split(/\r?\n/);
        const proxiesIndex = lines.findIndex(line => /^proxies:\s*(#.*)?$/.test(line.trim()));

        if (proxiesIndex >= 0) {
            let insertAt = lines.length;
            for (let i = proxiesIndex + 1; i < lines.length; i++) {
                const line = lines[i];
                if (/^\S/.test(line) && !line.startsWith('#')) {
                    insertAt = i;
                    break;
                }
            }

            const before = lines.slice(0, insertAt).join('\n').replace(/\s*$/, '');
            const after = lines.slice(insertAt).join('\n').replace(/^\s*/, '');
            const parts = [before, proxyLines];
            if (after) {
                parts.push(after);
            }
            return parts.filter(Boolean).join('\n');
        }

        let insertAt = 0;
        while (insertAt < lines.length && (/^\s*$/.test(lines[insertAt]) || lines[insertAt].startsWith('#'))) {
            insertAt += 1;
        }

        const before = lines.slice(0, insertAt).join('\n').replace(/\s*$/, '');
        const after = lines.slice(insertAt).join('\n').replace(/^\s*/, '');
        const parts = [];
        if (before) {
            parts.push(before);
        }
        parts.push(`proxies:\n${proxyLines}`);
        if (after) {
            parts.push(after);
        }
        return parts.join('\n\n');
    }

    resolveRuleTargetName(outbound) {
        if (outbound === 'Location:CN') {
            return 'DIRECT';
        }
        if (outbound === 'Private' || outbound === 'Non-China') {
            return this.t('outboundNames.Node Select');
        }
        return this.t(`outboundNames.${outbound}`);
    }

    /**
     * Check if subscription format is compatible for use as Clash proxy-provider
     * @param {'clash'|'singbox'|'unknown'} format - Detected subscription format
     * @returns {boolean} - True if format is Clash YAML
     */
    isCompatibleProviderFormat(format) {
        return format === 'clash';
    }

    /**
     * Generate proxy-providers configuration from collected URLs
     * @returns {object} - proxy-providers object
     */
    generateProxyProviders() {
        const providers = {};
        this.providerUrls.forEach((url, index) => {
            const name = `_auto_provider_${index + 1}`;
            providers[name] = {
                type: 'http',
                url: url,
                path: `./proxy_providers/${name}.yaml`,
                interval: 3600,
                'health-check': {
                    enable: true,
                    url: 'https://www.gstatic.com/generate_204',
                    interval: 300,
                    timeout: 5000,
                    lazy: true
                }
            };
        });
        return providers;
    }

    /**
     * Get list of provider names
     * @returns {string[]} - Array of provider names
     */
    getProviderNames() {
        return this.providerUrls.map((_, index) => `_auto_provider_${index + 1}`);
    }

    /**
     * Get all provider names (user-defined + auto-generated)
     * @returns {string[]} - Array of provider names
     */
    getAllProviderNames() {
        const existingProviders = this.config?.['proxy-providers'] && typeof this.config['proxy-providers'] === 'object'
            ? Object.keys(this.config['proxy-providers'])
            : [];
        const autoProviders = this.getProviderNames();
        return [...new Set([...existingProviders, ...autoProviders])];
    }

    getProxies() {
        return this.config.proxies || [];
    }

    getProxyName(proxy) {
        return proxy.name;
    }

    convertProxy(proxy) {
        const clashExtras = proxy?.dialer_proxy !== undefined ? { 'dialer-proxy': proxy.dialer_proxy } : {};
        switch (proxy.type) {
            case 'direct':
                return {
                    name: proxy.tag,
                    type: 'direct'
                };
            case 'shadowsocks':
                return {
                    name: proxy.tag,
                    type: 'ss',
                    server: proxy.server,
                    port: proxy.server_port,
                    cipher: proxy.method,
                    password: proxy.password,
                    ...(typeof proxy.udp !== 'undefined' ? { udp: proxy.udp } : {}),
                    ...(proxy.plugin ? { plugin: proxy.plugin } : {}),
                    ...(proxy.plugin_opts ? { 'plugin-opts': proxy.plugin_opts } : {}),
                    ...clashExtras
                };
            case 'vmess':
                return {
                    name: proxy.tag,
                    type: proxy.type,
                    server: proxy.server,
                    port: proxy.server_port,
                    uuid: proxy.uuid,
                    alterId: proxy.alter_id ?? 0,
                    cipher: proxy.security,
                    tls: proxy.tls?.enabled || false,
                    servername: proxy.tls?.server_name || '',
                    'skip-cert-verify': !!proxy.tls?.insecure,
                    network: proxy.transport?.type || proxy.network || 'tcp',
                    'ws-opts': proxy.transport?.type === 'ws'
                        ? {
                            path: proxy.transport.path,
                            headers: proxy.transport.headers
                        }
                        : undefined,
                    'http-opts': proxy.transport?.type === 'http'
                        ? (() => {
                            const opts = {
                                method: proxy.transport.method || 'GET',
                                path: Array.isArray(proxy.transport.path) ? proxy.transport.path : [proxy.transport.path || '/'],
                            };
                            if (proxy.transport.headers && Object.keys(proxy.transport.headers).length > 0) {
                                opts.headers = proxy.transport.headers;
                            }
                            return opts;
                        })()
                        : undefined,
                    'grpc-opts': proxy.transport?.type === 'grpc'
                        ? {
                            'grpc-service-name': proxy.transport.service_name
                        }
                        : undefined,
                    'h2-opts': proxy.transport?.type === 'h2'
                        ? {
                            path: proxy.transport.path,
                            host: proxy.transport.host
                        }
                        : undefined,
                    ...clashExtras
                };
            case 'vless':
                return {
                    name: proxy.tag,
                    type: proxy.type,
                    server: proxy.server,
                    port: proxy.server_port,
                    uuid: proxy.uuid,
                    cipher: proxy.security,
                    tls: proxy.tls?.enabled || false,
                    'client-fingerprint': proxy.tls?.utls?.fingerprint,
                    servername: proxy.tls?.server_name || '',
                    network: proxy.transport?.type || 'tcp',
                    'ws-opts': proxy.transport?.type === 'ws' ? {
                        path: proxy.transport.path,
                        headers: proxy.transport.headers
                    } : undefined,
                    'reality-opts': proxy.tls?.reality?.enabled ? {
                        'public-key': proxy.tls.reality.public_key,
                        'short-id': proxy.tls.reality.short_id,
                    } : undefined,
                    'grpc-opts': proxy.transport?.type === 'grpc' ? {
                        'grpc-service-name': proxy.transport.service_name,
                    } : undefined,
                    tfo: proxy.tcp_fast_open,
                    'skip-cert-verify': !!proxy.tls?.insecure,
                    ...(typeof proxy.udp !== 'undefined' ? { udp: proxy.udp } : {}),
                    ...(proxy.alpn ? { alpn: proxy.alpn } : {}),
                    ...(proxy.packet_encoding ? { 'packet-encoding': proxy.packet_encoding } : {}),
                    'flow': proxy.flow ?? undefined,
                    ...clashExtras
                };
            case 'hysteria2':
                return {
                    name: proxy.tag,
                    type: proxy.type,
                    server: proxy.server,
                    port: proxy.server_port,
                    ...(proxy.ports ? { ports: proxy.ports } : {}),
                    obfs: proxy.obfs?.type,
                    'obfs-password': proxy.obfs?.password,
                    password: proxy.password,
                    auth: proxy.auth,
                    up: proxy.up,
                    down: proxy.down,
                    'recv-window-conn': proxy.recv_window_conn,
                    sni: proxy.tls?.server_name || '',
                    'skip-cert-verify': !!proxy.tls?.insecure,
                    ...(proxy.hop_interval !== undefined ? { 'hop-interval': proxy.hop_interval } : {}),
                    ...(proxy.alpn ? { alpn: proxy.alpn } : {}),
                    ...(proxy.fast_open !== undefined ? { 'fast-open': proxy.fast_open } : {}),
                    ...clashExtras
                };
            case 'trojan':
                return {
                    name: proxy.tag,
                    type: proxy.type,
                    server: proxy.server,
                    port: proxy.server_port,
                    password: proxy.password,
                    cipher: proxy.security,
                    tls: proxy.tls?.enabled || false,
                    'client-fingerprint': proxy.tls?.utls?.fingerprint,
                    sni: proxy.tls?.server_name || '',
                    network: proxy.transport?.type || 'tcp',
                    'ws-opts': proxy.transport?.type === 'ws' ? {
                        path: proxy.transport.path,
                        headers: proxy.transport.headers
                    } : undefined,
                    'reality-opts': proxy.tls?.reality?.enabled ? {
                        'public-key': proxy.tls.reality.public_key,
                        'short-id': proxy.tls.reality.short_id,
                    } : undefined,
                    'grpc-opts': proxy.transport?.type === 'grpc' ? {
                        'grpc-service-name': proxy.transport.service_name,
                    } : undefined,
                    tfo: proxy.tcp_fast_open,
                    'skip-cert-verify': !!proxy.tls?.insecure,
                    ...(proxy.alpn ? { alpn: proxy.alpn } : {}),
                    'flow': proxy.flow ?? undefined,
                    ...clashExtras
                };
            case 'tuic':
                return {
                    name: proxy.tag,
                    type: proxy.type,
                    server: proxy.server,
                    port: proxy.server_port,
                    uuid: proxy.uuid,
                    password: proxy.password,
                    'congestion-controller': proxy.congestion_control,
                    'skip-cert-verify': !!proxy.tls?.insecure,
                    ...(proxy.disable_sni !== undefined ? { 'disable-sni': proxy.disable_sni } : {}),
                    ...(proxy.tls?.alpn ? { alpn: proxy.tls.alpn } : {}),
                    'sni': proxy.tls?.server_name,
                    'udp-relay-mode': proxy.udp_relay_mode || 'native',
                    ...(proxy.zero_rtt !== undefined ? { 'zero-rtt': proxy.zero_rtt } : {}),
                    ...(proxy.reduce_rtt !== undefined ? { 'reduce-rtt': proxy.reduce_rtt } : {}),
                    ...(proxy.fast_open !== undefined ? { 'fast-open': proxy.fast_open } : {}),
                    ...clashExtras
                };
            case 'anytls':
                return {
                    name: proxy.tag,
                    type: 'anytls',
                    server: proxy.server,
                    port: proxy.server_port,
                    password: proxy.password,
                    ...(proxy.udp !== undefined ? { udp: proxy.udp } : {}),
                    ...(proxy.tls?.utls?.fingerprint ? { 'client-fingerprint': proxy.tls.utls.fingerprint } : {}),
                    ...(proxy.tls?.server_name ? { sni: proxy.tls.server_name } : {}),
                    ...(proxy.tls?.insecure !== undefined ? { 'skip-cert-verify': !!proxy.tls.insecure } : {}),
                    ...(proxy.tls?.alpn ? { alpn: proxy.tls.alpn } : {}),
                    ...(proxy['idle-session-check-interval'] !== undefined ? { 'idle-session-check-interval': proxy['idle-session-check-interval'] } : {}),
                    ...(proxy['idle-session-timeout'] !== undefined ? { 'idle-session-timeout': proxy['idle-session-timeout'] } : {}),
                    ...(proxy['min-idle-session'] !== undefined ? { 'min-idle-session': proxy['min-idle-session'] } : {}),
                    ...clashExtras
                };
            default:
                return proxy; // Return as-is if no specific conversion is defined
        }
    }

    addProxyToConfig(proxy) {
        if (this.preserveMode) {
            if (!proxy?.name || this.preserveExistingProxyNames.has(proxy.name)) {
                return;
            }
            this.preserveExistingProxyNames.add(proxy.name);
            addProxyWithDedup(this.preserveAppendedProxies, proxy, {
                getName: (item) => item?.name,
                setName: (item, name) => {
                    if (item) item.name = name;
                },
                isSame: (a = {}, b = {}) => {
                    const { name: _name, ...restOfProxy } = b;
                    const { name: __name, ...restOfExisting } = a;
                    return JSON.stringify(restOfProxy) === JSON.stringify(restOfExisting);
                }
            });
            return;
        }
        this.config.proxies = this.config.proxies || [];
        addProxyWithDedup(this.config.proxies, proxy, {
            getName: (item) => item?.name,
            setName: (item, name) => {
                if (item) item.name = name;
            },
            isSame: (a = {}, b = {}) => {
                const { name: _name, ...restOfProxy } = b;
                const { name: __name, ...restOfExisting } = a;
                return JSON.stringify(restOfProxy) === JSON.stringify(restOfExisting);
            }
        });
    }

    hasProxyGroup(name) {
        const target = normalizeGroupName(name);
        return (this.config['proxy-groups'] || []).some(group => group && normalizeGroupName(group.name) === target);
    }

    addAutoSelectGroup(proxyList) {
        if (!this.includeAutoSelect) return;
        this.config['proxy-groups'] = this.config['proxy-groups'] || [];
        const autoName = this.t('outboundNames.Auto Select');
        if (this.hasProxyGroup(autoName)) return;

        const group = {
            name: autoName,
            type: 'url-test',
            proxies: deepCopy(uniqueNames(proxyList)),
            url: 'https://www.gstatic.com/generate_204',
            interval: 300,
            lazy: false,
            tolerance: 20
        };

        // Add 'use' field if we have proxy-providers
        const providerNames = this.getAllProviderNames();
        if (providerNames.length > 0) {
            group.use = providerNames;
        }

        this.config['proxy-groups'].push(group);
    }

    addNodeSelectGroup(proxyList) {
        this.config['proxy-groups'] = this.config['proxy-groups'] || [];
        const nodeName = this.t('outboundNames.Node Select');
        if (this.hasProxyGroup(nodeName)) return;
        const list = buildNodeSelectMembers({
            proxyList,
            translator: this.t,
            groupByCountry: this.groupByCountry,
            manualGroupName: this.manualGroupName,
            countryGroupNames: this.countryGroupNames,
            includeAutoSelect: this.includeAutoSelect
        });

        const group = {
            type: "select",
            name: nodeName,
            proxies: list
        };

        // Add 'use' field if we have proxy-providers
        const providerNames = this.getAllProviderNames();
        if (providerNames.length > 0) {
            group.use = providerNames;
        }

        this.config['proxy-groups'].unshift(group);
    }

    addFailoverGroup(proxyList) {
        this.config['proxy-groups'] = this.config['proxy-groups'] || [];
        const name = this.t('outboundNames.Failover');
        if (this.hasProxyGroup(name)) return;

        const group = this.groupByCountry
            ? {
                name,
                type: 'fallback',
                proxies: [
                    ...(this.manualGroupName ? [this.manualGroupName] : []),
                    ...this.countryGroupNames
                ],
                url: 'https://www.gstatic.com/generate_204',
                interval: 300,
                lazy: false
            }
            : {
                name,
                type: 'fallback',
                proxies: deepCopy(uniqueNames(proxyList)),
                url: 'https://www.gstatic.com/generate_204',
                interval: 300,
                lazy: false
            };

        this.config['proxy-groups'].push(group);
    }

    buildSelectGroupMembers(proxyList = []) {
        return buildSelectorMembers({
            proxyList,
            translator: this.t,
            groupByCountry: this.groupByCountry,
            manualGroupName: this.manualGroupName,
            countryGroupNames: this.countryGroupNames,
            includeAutoSelect: this.includeAutoSelect
        });
    }

    buildRuleGroupMembers() {
        const members = [
            this.t('outboundNames.Node Select'),
            this.t('outboundNames.Failover'),
            ...(this.includeAutoSelect ? [this.t('outboundNames.Auto Select')] : [])
        ];
        return uniqueNames(members);
    }

    addOutboundGroups(outbounds, proxyList) {
        outbounds.forEach(outbound => {
            if (this.getHiddenRuleGroups().has(outbound)) {
                return;
            }
            if (outbound !== this.t('outboundNames.Node Select')) {
                const name = this.t(`outboundNames.${outbound}`);
                if (!this.hasProxyGroup(name)) {
                    const proxies = outbound === 'Ad Block'
                        ? ['REJECT', 'DIRECT']
                        : this.buildRuleGroupMembers();
                    const group = {
                        type: "select",
                        name,
                        proxies
                    };
                    // Add 'use' field if we have proxy-providers
                    const providerNames = this.getAllProviderNames();
                    if (providerNames.length > 0) {
                        group.use = providerNames;
                    }
                    this.config['proxy-groups'].push(group);
                }
            }
        });
    }

    addCustomRuleGroups(proxyList) {
        if (Array.isArray(this.customRules)) {
            this.customRules.forEach(rule => {
                const name = this.t(`outboundNames.${rule.name}`);
                if (!this.hasProxyGroup(name)) {
                    const proxies = this.buildRuleGroupMembers();
                    const group = {
                        type: "select",
                        name,
                        proxies
                    };
                    // Add 'use' field if we have proxy-providers
                    const providerNames = this.getAllProviderNames();
                    if (providerNames.length > 0) {
                        group.use = providerNames;
                    }
                    this.config['proxy-groups'].push(group);
                }
            });
        }
    }

    addFallBackGroup(proxyList) {
        const name = this.t('outboundNames.Fall Back');
        if (this.hasProxyGroup(name)) return;
        const proxies = this.buildFallBackMembers(proxyList);
        const group = {
            type: "select",
            name,
            proxies
        };
        // Add 'use' field if we have proxy-providers
        const providerNames = this.getAllProviderNames();
        if (providerNames.length > 0) {
            group.use = providerNames;
        }
        this.config['proxy-groups'].push(group);
    }

    buildFallBackMembers(proxyList = []) {
        const nodeSelectName = this.t('outboundNames.Node Select');
        const autoSelectName = this.t('outboundNames.Auto Select');
        const failoverName = this.t('outboundNames.Failover');
        const members = this.groupByCountry
            ? [
                nodeSelectName,
                failoverName,
                ...(this.includeAutoSelect ? [autoSelectName] : []),
                'DIRECT'
            ]
            : [
                nodeSelectName,
                failoverName,
                ...(this.includeAutoSelect ? [autoSelectName] : []),
                'DIRECT'
            ];

        return uniqueNames(members);
    }

    reorderProxyGroups() {
        const groups = Array.isArray(this.config['proxy-groups']) ? [...this.config['proxy-groups']] : [];
        if (groups.length === 0) return;

        const priorityNames = [
            this.t('outboundNames.Node Select'),
            this.t('outboundNames.Auto Select'),
            this.t('outboundNames.Failover'),
            this.manualGroupName
        ].filter(Boolean);
        const fallbackName = normalizeGroupName(this.t('outboundNames.Fall Back'));

        const countryGroupSet = new Set(this.countryGroupNames);
        const priorityMap = new Map(priorityNames.map((name, index) => [normalizeGroupName(name), index]));

        groups.sort((a, b) => {
            const aName = normalizeGroupName(a?.name);
            const bName = normalizeGroupName(b?.name);
            const aPriority = aName === fallbackName
                ? 999
                : priorityMap.has(aName) ? priorityMap.get(aName) : (countryGroupSet.has(a?.name) ? 10 : 20);
            const bPriority = bName === fallbackName
                ? 999
                : priorityMap.has(bName) ? priorityMap.get(bName) : (countryGroupSet.has(b?.name) ? 10 : 20);

            if (aPriority !== bPriority) {
                return aPriority - bPriority;
            }

            return 0;
        });

        this.config['proxy-groups'] = groups;
    }

    buildOrderedConfig() {
        const preferredOrder = [
            'proxies',
            'proxy-providers',
            'mixed-port',
            'port',
            'socks-port',
            'allow-lan',
            'bind-address',
            'mode',
            'ipv6',
            'unified-delay',
            'tcp-concurrent',
            'log-level',
            'find-process-mode',
            'global-client-fingerprint',
            'keep-alive-idle',
            'keep-alive-interval',
            'profile',
            'sniffer',
            'tun',
            'geodata-mode',
            'geo-auto-update',
            'geodata-loader',
            'geo-update-interval',
            'geox-url',
            'dns',
            'proxy-groups',
            'rules',
            'rule-providers',
            'external-controller',
            'external-ui',
            'external-ui-name',
            'external-ui-url',
            'secret'
        ];

        const ordered = {};
        preferredOrder.forEach(key => {
            if (Object.prototype.hasOwnProperty.call(this.config, key)) {
                ordered[key] = this.config[key];
            }
        });

        Object.entries(this.config).forEach(([key, value]) => {
            if (!Object.prototype.hasOwnProperty.call(ordered, key)) {
                ordered[key] = value;
            }
        });

        return ordered;
    }

    dumpTopLevelSection(key, value) {
        const baseOptions = {
            lineWidth: -1,
            noRefs: true
        };

        if (key === 'proxies' || key === 'proxy-groups') {
            if (!Array.isArray(value) || value.length === 0) {
                return `${key}: []`;
            }
            const lines = [`${key}:`];
            value.forEach(item => {
                const normalizedItem = this.normalizeInlineObject(key, item);
                const rendered = yaml.dump([normalizedItem], {
                    ...baseOptions,
                    flowLevel: 1
                }).trimEnd();
                lines.push(...rendered.split('\n').map(line => `  ${line}`));
            });
            return lines.join('\n');
        }

        if (key === 'rule-providers' || key === 'proxy-providers') {
            if (!value || Object.keys(value).length === 0) {
                return `${key}: {}`;
            }
            if (key === 'rule-providers') {
                return this.dumpRuleProvidersWithAnchors(value);
            }
            const lines = [`${key}:`];
            Object.entries(value).forEach(([providerName, providerConfig]) => {
                const rendered = yaml.dump({ [providerName]: this.normalizeInlineObject(key, providerConfig) }, {
                    ...baseOptions,
                    flowLevel: 1
                }).trimEnd();
                lines.push(...rendered.split('\n').map(line => `  ${line}`));
            });
            return lines.join('\n');
        }

        if (key === 'sniffer') {
            return yaml.dump({ [key]: value }, {
                ...baseOptions,
                flowLevel: 3
            }).trimEnd();
        }

        if (key === 'tun' || key === 'dns') {
            return yaml.dump({ [key]: value }, {
                ...baseOptions,
                flowLevel: 2
            }).trimEnd();
        }

        return yaml.dump({ [key]: value }, baseOptions).trimEnd();
    }

    dumpInlineObject(value) {
        return yaml.dump(value, {
            flowLevel: 0,
            lineWidth: -1,
            noRefs: true
        }).trimEnd();
    }

    normalizeInlineObject(sectionKey, value) {
        if (!value || Array.isArray(value) || typeof value !== 'object') {
            return value;
        }

        let preferredKeys = [];
        if (sectionKey === 'proxy-groups') {
            preferredKeys = ['name', 'type', 'proxies', 'use', 'include-all', 'filter', 'url', 'interval', 'lazy', 'tolerance'];
        } else if (sectionKey === 'rule-providers' || sectionKey === 'proxy-providers') {
            preferredKeys = ['type', 'format', 'behavior', 'url', 'path', 'interval', 'health-check'];
        } else if (sectionKey === 'proxies') {
            preferredKeys = ['name', 'type', 'server', 'port', 'ports', 'uuid', 'password', 'cipher', 'udp', 'dialer-proxy', 'tls', 'client-fingerprint', 'servername', 'sni', 'network', 'ws-opts', 'reality-opts', 'grpc-opts', 'tfo', 'skip-cert-verify', 'flow'];
        }

        const normalized = {};
        preferredKeys.forEach(key => {
            if (Object.prototype.hasOwnProperty.call(value, key) && value[key] !== undefined) {
                normalized[key] = value[key];
            }
        });

        Object.entries(value).forEach(([key, entryValue]) => {
            if (!Object.prototype.hasOwnProperty.call(normalized, key) && entryValue !== undefined) {
                normalized[key] = entryValue;
            }
        });

        return normalized;
    }

    buildRuleAnchorTemplates(providers) {
        const defaults = {
            ip: { type: 'http', interval: 86400, behavior: 'ipcidr', format: 'mrs' },
            domain: { type: 'http', interval: 86400, behavior: 'domain', format: 'mrs' },
            class: { type: 'http', interval: 86400, behavior: 'classical', format: 'text' }
        };

        Object.values(providers || {}).forEach(provider => {
            if (!provider || typeof provider !== 'object') return;
            if (provider.behavior === 'ipcidr') {
                defaults.ip = {
                    type: provider.type,
                    interval: provider.interval,
                    behavior: provider.behavior,
                    format: provider.format
                };
            } else if (provider.behavior === 'domain') {
                defaults.domain = {
                    type: provider.type,
                    interval: provider.interval,
                    behavior: provider.behavior,
                    format: provider.format
                };
            } else if (provider.behavior === 'classical') {
                defaults.class = {
                    type: provider.type,
                    interval: provider.interval,
                    behavior: provider.behavior,
                    format: provider.format
                };
            }
        });

        return defaults;
    }

    dumpRuleProvidersWithAnchors(providers) {
        const anchors = this.buildRuleAnchorTemplates(providers);
        const lines = [
            'rule-anchor:',
            `  ip: &ip ${this.dumpInlineObject(anchors.ip)}`,
            `  domain: &domain ${this.dumpInlineObject(anchors.domain)}`,
            `  class: &class ${this.dumpInlineObject(anchors.class)}`,
            'rule-providers:'
        ];

        Object.entries(providers).forEach(([providerName, providerConfig]) => {
            const normalized = this.normalizeInlineObject('rule-providers', providerConfig);
            const anchorName = normalized.behavior === 'ipcidr'
                ? 'ip'
                : normalized.behavior === 'classical'
                    ? 'class'
                    : 'domain';

            const inlineConfig = { ...normalized };
            delete inlineConfig.type;
            delete inlineConfig.interval;
            delete inlineConfig.behavior;
            delete inlineConfig.format;

            const serialized = this.dumpInlineObject(inlineConfig);
            const inner = serialized.startsWith('{') && serialized.endsWith('}')
                ? serialized.slice(1, -1).trim()
                : serialized;
            const suffix = inner ? `, ${inner}` : '';
            lines.push(`  ${providerName}: {<<: *${anchorName}${suffix}}`);
        });

        return lines.join('\n');
    }

    getSectionHeader(key) {
        switch (key) {
            case 'proxies':
                return '# 节点信息';
            case 'mixed-port':
                return '# 全局配置';
            case 'sniffer':
                return '# 嗅探';
            case 'tun':
                return '# 入站';
            case 'dns':
                return '# DNS模块';
            case 'proxy-groups':
                return '# 出站策略';
            case 'rules':
                return '# 规则匹配';
            case 'rule-providers':
                return '# 规则集\n## type: http/file/inline  behavior: domain/ipcidr/classical  format: yaml/text/mrs';
            default:
                return '';
        }
    }

    dumpFormattedConfig(config) {
        const lines = [];

        Object.entries(config).forEach(([key, value]) => {
            const header = this.getSectionHeader(key);
            if (header) {
                if (lines.length > 0) {
                    lines.push('');
                }
                lines.push(header);
            }
            lines.push(this.dumpTopLevelSection(key, value));
        });

        return lines.join('\n');
    }

    addCountryGroups() {
        const proxies = this.getProxies();
        const countryGroups = groupProxiesByCountry(proxies, {
            getName: proxy => this.getProxyName(proxy)
        });

        const existingNames = new Set((this.config['proxy-groups'] || []).map(g => normalizeGroupName(g?.name)).filter(Boolean));

        const manualProxyNames = proxies.map(p => p?.name).filter(Boolean);
        const manualGroupName = manualProxyNames.length > 0 ? this.t('outboundNames.Manual Switch') : null;
        if (manualGroupName) {
            const manualNorm = normalizeGroupName(manualGroupName);
            if (!existingNames.has(manualNorm)) {
                const group = {
                    name: manualGroupName,
                    type: 'select',
                    proxies: manualProxyNames
                };
                // Add 'use' field if we have proxy-providers
                const providerNames = this.getAllProviderNames();
                if (providerNames.length > 0) {
                    group.use = providerNames;
                }
                this.config['proxy-groups'].push(group);
                existingNames.add(manualNorm);
            }
        }

        const countries = Object.keys(countryGroups).sort((a, b) => a.localeCompare(b));
        const countryGroupNames = [];

        countries.forEach(country => {
            const { emoji, name, proxies } = countryGroups[country];
            const groupName = `${emoji} ${name}`;
            const norm = normalizeGroupName(groupName);
            if (!existingNames.has(norm)) {
                const group = {
                    name: groupName,
                    type: 'url-test',
                    proxies: proxies,
                    url: 'https://www.gstatic.com/generate_204',
                    interval: 300,
                    lazy: false
                };
                // Add 'use' field if we have proxy-providers
                const providerNames = this.getAllProviderNames();
                if (providerNames.length > 0) {
                    group.use = providerNames;
                }
                this.config['proxy-groups'].push(group);
                existingNames.add(norm);
            }
            countryGroupNames.push(groupName);
        });

        const nodeSelectGroup = this.config['proxy-groups'].find(g => g && g.name === this.t('outboundNames.Node Select'));
        if (nodeSelectGroup && Array.isArray(nodeSelectGroup.proxies)) {
            const rebuilt = buildNodeSelectMembers({
                proxyList: [],
                translator: this.t,
                groupByCountry: true,
                manualGroupName,
                countryGroupNames,
                includeAutoSelect: this.includeAutoSelect
            });
            nodeSelectGroup.proxies = rebuilt;
        }
        this.countryGroupNames = countryGroupNames;
        this.manualGroupName = manualGroupName;
    }

    addSelectors() {
        if (this.preserveMode) {
            return;
        }
        const outbounds = this.getOutboundsList();
        const proxyList = this.getProxyList();

        this.addAutoSelectGroup(proxyList);
        this.addNodeSelectGroup(proxyList);
        if (this.groupByCountry) {
            this.addCountryGroups();
        }
        this.addFailoverGroup(proxyList);
        this.addOutboundGroups(outbounds, proxyList);
        this.addCustomRuleGroups(proxyList);
        this.addFallBackGroup(proxyList);

        if (this.pendingUserProxyGroups && this.pendingUserProxyGroups.length > 0) {
            this.mergeUserProxyGroups(this.pendingUserProxyGroups);
        }
    }

    /**
     * Merge user-defined proxy groups with system-generated ones
     * Handles same-name groups by merging proxies/use fields and preserving user settings
     * @param {Array} userGroups - User-defined proxy groups from input config
     */
    mergeUserProxyGroups(userGroups) {
        if (!Array.isArray(userGroups)) return;

        const proxyList = this.getProxyList();
        const allProviderNames = new Set(this.getAllProviderNames());

        // Build valid reference set (proxies, groups, special names)
        const groupNames = new Set(
            (this.config['proxy-groups'] || [])
                .map(g => normalizeGroupName(g?.name))
                .filter(Boolean)
        );
        const validRefs = new Set(['DIRECT', 'REJECT']);
        proxyList.forEach(n => validRefs.add(n));
        groupNames.forEach(n => validRefs.add(n));

        userGroups.forEach(userGroup => {
            if (!userGroup?.name) return;

            const existingIndex = findGroupIndexByName(
                this.config['proxy-groups'],
                userGroup.name
            );

            if (existingIndex >= 0) {
                // Merge with existing system group
                const existing = this.config['proxy-groups'][existingIndex];

                // Merge 'use' field (provider references)
                if (Array.isArray(userGroup.use) && userGroup.use.length > 0) {
                    const validUserProviders = userGroup.use.filter(p => allProviderNames.has(p));
                    existing.use = [...new Set([
                        ...(existing.use || []),
                        ...validUserProviders
                    ])];
                }

                // Merge 'proxies' field - validate references first
                if (Array.isArray(userGroup.proxies)) {
                    const validUserProxies = userGroup.proxies.filter(p => validRefs.has(p));
                    existing.proxies = [...new Set([
                        ...(existing.proxies || []),
                        ...validUserProxies
                    ])];
                }

                // Preserve user's custom settings (url, interval)
                if (userGroup.url) existing.url = userGroup.url;
                if (typeof userGroup.interval === 'number') existing.interval = userGroup.interval;
                if (typeof userGroup.lazy === 'boolean') existing.lazy = userGroup.lazy;
            } else {
                // New user-defined group - validate and add
                const newGroup = { ...userGroup };

                // Validate proxies references
                if (Array.isArray(newGroup.proxies)) {
                    newGroup.proxies = newGroup.proxies.filter(p => validRefs.has(p));
                }

                // Validate use (provider) references
                if (Array.isArray(newGroup.use)) {
                    newGroup.use = newGroup.use.filter(p => allProviderNames.has(p));
                }

                // Add group if:
                // 1. Has valid proxies or use, OR
                // 2. Is url-test/fallback type (will be filled by validateProxyGroups)
                const isAutoFillableType = newGroup.type === 'url-test' || newGroup.type === 'fallback';
                if ((newGroup.proxies?.length > 0) || (newGroup.use?.length > 0) || isAutoFillableType) {
                    this.config['proxy-groups'].push(newGroup);
                }
            }
        });
    }

    /**
     * Validate proxy groups before final output
     * Ensures url-test/fallback groups have proxies, fills empty ones with all nodes
     */
    validateProxyGroups() {
        const proxyList = this.getProxyList();
        const providerNames = this.getAllProviderNames();

        (this.config['proxy-groups'] || []).forEach(group => {
            // For url-test/fallback groups, ensure they have proxies or providers
            if ((group.type === 'url-test' || group.type === 'fallback') &&
                (!group.proxies || group.proxies.length === 0) &&
                (!group.use || group.use.length === 0)) {
                // Fill with all available proxies
                group.proxies = [...proxyList];
                // Also use all providers if available
                if (providerNames.length > 0) {
                    group.use = [...providerNames];
                }
            }
        });
    }

    // 生成规则
    generateRules() {
        return generateRules(this.selectedRules, this.customRules);
    }

    formatConfig() {
        if (this.preserveMode) {
            return this.mergePreserveRawConfig();
        }
        const rules = this.generateRules();
        const useMrs = supportsMrsFormat(this.userAgent);
        const { site_rule_providers, ip_rule_providers } = generateClashRuleSets(this.selectedRules, this.customRules, useMrs);
        this.config['rule-providers'] = {
            ...site_rule_providers,
            ...ip_rule_providers
        };
        const ruleResults = emitClashRules(rules, this.t, (outbound) => this.resolveRuleTargetName(outbound));

        // Add proxy-providers if we have any
        if (this.providerUrls.length > 0) {
            this.config['proxy-providers'] = {
                ...this.config['proxy-providers'],
                ...this.generateProxyProviders()
            };
        }

        // Validate proxy groups: fill empty url-test/fallback groups with all proxies
        this.validateProxyGroups();

        sanitizeClashProxyGroups(this.config);
        this.reorderProxyGroups();

        this.config.rules = [
            ...ruleResults,
            `MATCH,${this.t('outboundNames.Fall Back')}`
        ];

        // Enable Clash UI (external controller/dashboard) when requested or when custom UI params are provided
        if (this.enableClashUI || this.externalController || this.externalUiDownloadUrl) {
            const defaultController = '0.0.0.0:9090';
            const defaultUiPath = './ui';
            const defaultUiName = 'zashboard';
            const defaultUiUrl = 'https://gh-proxy.com/https://github.com/Zephyruso/zashboard/archive/refs/heads/gh-pages.zip';
            const defaultSecret = '';

            const controller = this.externalController || this.config['external-controller'] || defaultController;
            const uiPath = this.config['external-ui'] || defaultUiPath;
            const uiName = this.config['external-ui-name'] || defaultUiName;
            const uiUrl = this.externalUiDownloadUrl || this.config['external-ui-url'] || defaultUiUrl;
            const secret = this.config['secret'] ?? defaultSecret;

            this.config['external-controller'] = controller;
            this.config['external-ui'] = uiPath;
            this.config['external-ui-name'] = uiName;
            this.config['external-ui-url'] = uiUrl;
            this.config['secret'] = secret;
        }

        return this.dumpFormattedConfig(this.buildOrderedConfig());
    }
}
