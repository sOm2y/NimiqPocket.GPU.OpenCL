const fs = require('fs');
const os = require('os');
const ip = require('ip');
const JSON5 = require('json5');
const Nimiq = require('@nimiq/core');
const NanoPoolMiner = require('./src/NanoPoolMiner');
const Log = Nimiq.Log;

const TAG = 'NimiqpocketMiner';
const $ = {};

let Finder = require('./src/ServerFinder.js');
const ServerFinder = new Finder();

const servers = [
    'us.nimiqpocket.com',
    'hk.nimiqpocket.com'
];
const defaultConfigFile = 'config.txt';

Log.instance.level = 'info';


function humanHashrate(hashes) {
    let thresh = 1000;
    if (Math.abs(hashes) < thresh) {
        return hashes + ' H/s';
    }
    let units = ['kH/s', 'MH/s', 'GH/s', 'TH/s', 'PH/s', 'EH/s', 'ZH/s', 'YH/s'];
    let u = -1;
    do {
        hashes /= thresh;
        ++u;
    } while (Math.abs(hashes) >= thresh && u < units.length - 1);
    return hashes.toFixed(1) + ' ' + units[u];
}

function readConfigFile(fileName) {
    try {
        const config = JSON5.parse(fs.readFileSync(fileName));
        // TODO: Validate
        return config;
    } catch (e) {
        Log.e(TAG, `Failed to read config file ${fileName}: ${e.message}`);
        return false;
    }
}

config = readConfigFile(defaultConfigFile);

if (!config) {
    process.exit(1);
}

(async () => {

    Nimiq.GenesisConfig.main();
    const networkConfig = new Nimiq.DumbNetworkConfig();
    $.consensus = await Nimiq.Consensus.nano(networkConfig);

    $.blockchain = $.consensus.blockchain;
    $.network = $.consensus.network;

    const address = Nimiq.Address.fromUserFriendlyAddress(config.address);

    let deviceName = config.name || '*';
    if (deviceName === '*') {
        deviceName = [ip.address(), os.platform(), os.arch(), os.release()].join(' ');
    }

    const serversSorted = await ServerFinder.findClosestServers(servers, config.port);
    const closestServer = serversSorted[0];
    if(!config.server) {
        config.server = closestServer.host;
        Nimiq.Log.i(TAG, `Closest server: ${config.server}`);
    }
    config.host = config.server;
    config.port = 8444;

    const deviceId = Nimiq.BasePoolMiner.generateDeviceId(networkConfig);
    const hashrate = (config.hashrate > 0) ? config.hashrate : 100; // 100 kH/s by default
    const desiredSps = 5;
    const startDifficulty = (1e3 * hashrate * desiredSps) / (1 << 16);
    const minerVersion = 'GPU Miner 1.0.0';
    const deviceData = { deviceName, startDifficulty, minerVersion };

    Log.i(TAG, `NimiqPocket ${minerVersion} starting`);
    Log.i(TAG, `- pool server      = ${config.host}:${config.port}`);
    Log.i(TAG, `- address          = ${address.toUserFriendlyAddress()}`);
    Log.i(TAG, `- device name      = ${deviceName}`);

    $.miner = new NanoPoolMiner($.blockchain, $.network.time, address, deviceId, deviceData,
        config.devices, config.memory);

    $.miner.on('share', (block, blockValid) => {
        Log.i(TAG, `Found share. Nonce: ${block.header.nonce}`);
    });
    $.miner.on('hashrates-changed', hashrates => {
        const totalHashRate = hashrates.reduce((a, b) => a + b);
        const gpuInfo = $.miner.gpuInfo;
        Log.i(TAG, `Hashrate: ${humanHashrate(totalHashRate)} | ${hashrates.map((hr, idx) => `GPU${gpuInfo[idx].idx}: ${humanHashrate(hr)}`).join(' | ')}`);
    });

    $.consensus.on('established', () => {
        Log.i(TAG, `Connecting to ${config.host}`);
        $.miner.connect(config.host, config.port);
    });
    $.consensus.on('lost', () => {
        $.miner.disconnect();
    });

    $.blockchain.on('head-changed', (head) => {
        if ($.consensus.established || head.height % 100 === 0) {
            Log.i(TAG, `Now at block: ${head.height}`);
        }
    });

    $.network.on('peer-joined', (peer) => {
        Log.i(TAG, `Connected to ${peer.peerAddress.toString()}`);
    });
    $.network.on('peer-left', (peer) => {
        Log.i(TAG, `Disconnected from ${peer.peerAddress.toString()}`);
    });

    Log.i(TAG, 'Connecting to Nimiq network');
    $.network.connect();

})().catch(e => {
    console.error(e);
    process.exit(1);
});
