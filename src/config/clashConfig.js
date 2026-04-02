/**
 * Clash Configuration
 * Base configuration template for Clash client
 */

export const CLASH_CONFIG = {
	'mixed-port': 7890,
	'socks-port': 7891,
	'allow-lan': false,
	'bind-address': '*',
	'mode': 'rule',
	'ipv6': false,
	'unified-delay': true,
	'tcp-concurrent': true,
	'log-level': 'warning',
	'find-process-mode': 'off',
	'global-client-fingerprint': 'chrome',
	'keep-alive-idle': 600,
	'keep-alive-interval': 15,
	'profile': {
		'store-selected': true,
		'store-fake-ip': true
	},
	'geodata-mode': true,
	'geo-auto-update': true,
	'geodata-loader': 'standard',
	'geo-update-interval': 24,
	'geox-url': {
		'geoip': "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geoip.dat",
		'geosite': "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/geosite.dat",
		'mmdb': "https://testingcf.jsdelivr.net/gh/MetaCubeX/meta-rules-dat@release/country.mmdb",
		'asn': "https://github.com/xishang0128/geoip/releases/download/latest/GeoLite2-ASN.mmdb"
	},
	'sniffer': {
		'enable': true,
		'sniff': {
			'HTTP': {
				'ports': [80, '8080-8880'],
				'override-destination': false
			},
			'TLS': {
				'ports': [443, 8443]
			},
			'QUIC': {
				'ports': [443, 8443]
			}
		},
		'skip-domain': [
			'Mijia Cloud',
			'+.push.apple.com'
		]
	},
	'tun': {
		'enable': true,
		'stack': 'mixed',
		'dns-hijack': ['any:53', 'tcp://any:53'],
		'auto-route': true,
		'auto-redirect': true,
		'auto-detect-interface': true,
		'strict-route': true
	},
	'rule-providers': {
		// 将由代码自动生成
	},
	'dns': {
		'enable': true,
		'cache-algorithm': 'arc',
		'listen': '0.0.0.0:1053',
		'ipv6': false,
		'respect-rules': true,
		'enhanced-mode': 'fake-ip',
		'fake-ip-range': '28.0.0.1/8',
		'fake-ip-filter-mode': 'blacklist',
		'default-nameserver': [
			'https://223.5.5.5/dns-query',
			'https://120.53.53.53/dns-query'
		],
		'nameserver': [
			'https://8.8.8.8/dns-query#RULES&ecs=223.5.5.0/24',
			'https://1.1.1.1/dns-query#RULES&ecs=223.5.5.0/24'
		],
		'proxy-server-nameserver': [
			'https://dns.alidns.com/dns-query',
			'https://doh.pub/dns-query'
		],
		'direct-nameserver': [
			'https://dns.alidns.com/dns-query',
			'https://doh.pub/dns-query'
		],
		'nameserver-policy': {
			'geosite:cn,private': [
				'https://dns.alidns.com/dns-query',
				'https://doh.pub/dns-query'
			],
			'geosite:geolocation-!cn': [
				'https://dns.cloudflare.com/dns-query',
				'https://dns.google/dns-query'
			]
		},
		'fake-ip-filter': [
			'*.lan',
			'*.local',
			'localhost',
			'Mijia Cloud',
			'+.push.apple.com'
		]
	},
	'proxies': [],
	'proxy-groups': []
};
