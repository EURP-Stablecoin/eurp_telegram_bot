import dotenv from "dotenv";
dotenv.config();

import { ethers } from "ethers";
import TelegramBot from "node-telegram-bot-api";
import pRetry from "p-retry";

const {
    RPC_URL,
    TELEGRAM_TOKEN,
    TELEGRAM_CHAT_ID,
    CONFIRMATIONS = "1",
    TOKEN_ADDRESS
} = process.env;

if (!RPC_URL || !TELEGRAM_TOKEN || !TELEGRAM_CHAT_ID) {
    console.error("Missing env. Set RPC_URL, TELEGRAM_TOKEN and TELEGRAM_CHAT_ID.");
    process.exit(1);
}

const provider = new ethers.JsonRpcProvider(RPC_URL, { name: "base", chainId: 84532 });
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });

// Transfer topic
const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

// Minimal ERC-20 ABI
const ERC20_ABI = [
    "function symbol() view returns (string)",
    "function decimals() view returns (uint8)",
    "event Transfer(address indexed from, address indexed to, uint256 value)"
];

// caches
const tokenCache = new Map();
const lastSeenTx = new Set();

async function getTokenMeta(address) {
    address = ethers.getAddress(address);
    if (tokenCache.has(address)) return tokenCache.get(address);
    const contract = new ethers.Contract(address, ERC20_ABI, provider);
    const symbol = await pRetry(() => contract.symbol(), { retries: 2, factor: 1.5 });
    const decimals = await pRetry(() => contract.decimals(), { retries: 2, factor: 1.5 });
    const meta = { symbol, decimals: Number(decimals), fetchedAt: Date.now() };
    tokenCache.set(address, meta);
    return meta;
}

function formatAmount(valueBN, decimals) {
    try {
        return ethers.formatUnits(valueBN, decimals);
    } catch {
        return valueBN.toString();
    }
}

function txLink(txHash) {
    return `https://basescan.org/tx/${txHash}`;
}

async function handleLog(log) {
    try {
        if (lastSeenTx.has(log.transactionHash)) return;

        const iface = new ethers.Interface(ERC20_ABI);
        const parsed = iface.parseLog({ topics: log.topics, data: log.data });

        const from = parsed.args.from;
        const to = parsed.args.to;
        const value = parsed.args.value;

        // 🧠 Filter only transfers where from or to is zero address
        const ZERO = "0x0000000000000000000000000000000000000000";
        if (from.toLowerCase() !== ZERO && to.toLowerCase() !== ZERO) {
            return; // skip normal transfers
        }

        const type = from.toLowerCase() === ZERO ? "🪙 Mint" : "🔥 Burn";

        const tokenAddr = ethers.getAddress(log.address);
        let meta;
        try {
            meta = await getTokenMeta(tokenAddr);
        } catch (err) {
            console.warn(`Failed fetching token meta for ${tokenAddr}:`, err?.message ?? err);
            meta = { symbol: "TOKEN", decimals: 18 };
        }

        const amountStr = formatAmount(value, meta.decimals);

        const msg =
            `${type} detected on *Base*\n\n` +
            `*Token:* ${meta.symbol} (\`${tokenAddr}\`)\n` +
            `*From:* \`${from}\`\n` +
            `*To:* \`${to}\`\n` +
            `*Amount:* \`${amountStr}\`\n` +
            `*Tx:* [${log.transactionHash}](${txLink(log.transactionHash)})\n` +
            `*Block:* ${log.blockNumber}`;

        await bot.sendMessage(TELEGRAM_CHAT_ID, msg, {
            parse_mode: "Markdown",
            disable_web_page_preview: true
        });

        lastSeenTx.add(log.transactionHash);
        if (lastSeenTx.size > 1000) {
            const it = lastSeenTx.values();
            for (let i = 0; i < 200; i++) lastSeenTx.delete(it.next().value);
        }
    } catch (err) {
        console.error("Error handling log:", err);
    }
}

function startListening() {
    console.log("Listening for Mint/Burn Transfer events on Base RPC:", RPC_URL);

    const filter = {
        address: TOKEN_ADDRESS,
        topics: [TRANSFER_TOPIC]
    };

    provider.on(filter, async (log) => {
        if (!log || !log.transactionHash) return;
        const minConfirmations = Number(CONFIRMATIONS || 1);
        if (minConfirmations > 1) {
            try {
                const latest = await provider.getBlockNumber();
                if (log.blockNumber + minConfirmations - 1 > latest) {
                    setTimeout(() => provider.getBlock(log.blockNumber).catch(() => {}), 30000);
                    return;
                }
            } catch {}
        }
        handleLog(log).catch(err => console.error("handleLog error :", err));
    });

    if (provider instanceof ethers.WebSocketProvider) {
        provider.on("error", (err) => console.error("Provider error:", err));
        provider.on("close", () => console.warn("Provider connection closed — attempting to reconnect..."));
    }
}

(async () => {
    try {
        await provider.getBlockNumber();
        console.log("Connected to Base RPC, best block:", await provider.getBlockNumber());

        const me = await bot.getMe();
        console.log("Telegram bot:", me.username);

        startListening();
    } catch (err) {
        console.error("Startup error:", err);
        process.exit(1);
    }
})();