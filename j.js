const { StringSession } = require("telegram/sessions");
const axios = require("axios");
const fs = require("fs").promises;
const { TelegramClient, Api } = require("telegram");
require('dotenv').config()
const express = require('express')
const app = express()
const port = process.env.PORT || 4000;

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})

const apiId = Number(process.env.apiId);
const apiHash = process.env.apiHash;
const chatId = process.env.chatId;
const Pending = "Transaction is Pending";
const apiUrl = `https://server.sahulatpay.com/transactions/tele?status=failed&response_message=${Pending}`;
const sessionFile = "telegram_session.txt";

let transactionList = [];
let client;
let fetchInterval = 10000; // 10 sec initial fetch interval
let fetchedCount = 0;
let processedCount = 0;

// Get log file name based on current date
const getLogFileName = (date = new Date()) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    return `transactions_log_${year}-${month}.json`;
};

// Load transactions from JSON file
const loadTransactions = async (date) => {
    const fileName = getLogFileName(date);
    try {
        const data = await fs.readFile(fileName, "utf8");
        return JSON.parse(data);
    } catch (err) {
        if (err.code === "ENOENT") return {};
        console.error(`Error loading transactions from ${fileName}:`, err.message);
        return {};
    }
};

// Save transactions to JSON file
const saveTransactions = async (transactions, date = new Date()) => {
    const fileName = getLogFileName(date);
    try {
        await fs.writeFile(fileName, JSON.stringify(transactions, null, 2), "utf8");
    } catch (err) {
        console.error(`Error saving transactions to ${fileName}:`, err.message);
    }
};

// Load session from file
const loadSession = async () => {
    try {
        const sessionData = await fs.readFile(sessionFile, "utf8");
        return new StringSession(sessionData.trim());
    } catch (err) {
        console.log("No session file found, creating a new one.");
        return new StringSession("");
    }
};

// Save session to file
const saveSession = async (session) => {
    await fs.writeFile(sessionFile, session, "utf8");
    console.log("Session saved to", sessionFile);
};

// Get default time range (midnight today to now)
const getTimeRange = () => {
    const now = new Date();
    const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0);
    return { startTime: startOfDay, endTime: now };
};

// Log transaction to JSON file
const logTransaction = async (id, status, apiTimestamp, error = null) => {
    const date = new Date();
    const transactions = await loadTransactions(date);
    const now = new Date().toISOString();

    if (!transactions[id]) {
        transactions[id] = {
            status,
            error,
            timestamp: apiTimestamp,
            fetchedAt: now,
            sentAt: null,
        };
    } else {
        transactions[id].status = status;
        transactions[id].error = error;
        if (status === "sent") transactions[id].sentAt = now;
        else if (status === "failed") transactions[id].sentAt = null;
    }
    await saveTransactions(transactions, date);
};

// Ensure Telegram client is connected
const ensureConnected = async () => {
    try {
        if (!client || !(await client.isUserAuthorized())) {
            console.log("Client disconnected. Reconnecting...");
            await client.connect();
            if (!(await client.isUserAuthorized())) {
                throw new Error("Authorization lost");
            }
            console.log("Reconnected successfully.");
        }
    } catch (err) {
        console.error("Connection lost:", err.message);
        await new Promise((resolve) => setTimeout(resolve, 5000));
        return ensureConnected();
    }
};

// Fetch transactions
const fetchTransactions = async () => {
    try {
        const response = await axios.get(apiUrl, { timeout: 10000 });
        if (!response.data || typeof response.data !== "object") return [];

        let transactions = response.data.transactions || response.data;
        if (!Array.isArray(transactions)) return [];

        const { startTime, endTime } = getTimeRange();
        const currentMonth = new Date(startTime.getFullYear(), startTime.getMonth(), 1);
        const loggedTransactions = await loadTransactions(currentMonth);
        const sentIds = new Set(Object.entries(loggedTransactions)
            .filter(([, data]) => data.status === "sent")
            .map(([id]) => id));

        let newTransactions = transactions
            .filter((tx) => {
                if (!tx.date_time || typeof tx.date_time !== "string") return false;
                let txDate;
                try {
                    txDate = new Date(tx.date_time);
                    if (isNaN(txDate.getTime())) {
                        txDate = new Date(tx.date_time.replace(" ", "T") + ".000Z");
                        if (isNaN(txDate.getTime())) return false;
                    }
                } catch (error) {
                    return false;
                }
                return txDate >= startTime && txDate <= endTime && !sentIds.has(tx.merchant_transaction_id);
            })
            .map((tx) => ({ id: tx.merchant_transaction_id, timestamp: tx.date_time }));

        fetchedCount += newTransactions.length;
        for (const tx of newTransactions) {
            await logTransaction(tx.id, "fetched", tx.timestamp);
        }
        transactionList = [...transactionList, ...newTransactions.map(tx => tx.id)];
        console.log(`Fetched: ${fetchedCount}, Pending: ${transactionList.length}`);
    } catch (error) {
        console.error("Error fetching transactions:", error.message);
    }
};

// Send messages in batches
const sendMessagesWithDelay = async () => {
    while (transactionList.length > 0) {
        await ensureConnected();
        const batch = transactionList.splice(0, 6);
        const message = `/in ${batch.join(" ")}`;

        try {
            console.log(`Sending: ${message}`);
            await client.sendMessage(chatId, { message });
            const transactions = await loadTransactions(new Date());
            for (const id of batch) {
                const apiTimestamp = transactions[id]?.timestamp || new Date().toISOString();
                await logTransaction(id, "sent", apiTimestamp);
            }
            processedCount += batch.length;
            console.log(`Processed: ${processedCount}, Remaining: ${transactionList.length}`);
            await new Promise((resolve) => setTimeout(resolve, 30000));
        } catch (err) {
            console.error(`Failed to send: ${message}`, err.message);
            const transactions = await loadTransactions(new Date());
            for (const id of batch) {
                const apiTimestamp = transactions[id]?.timestamp || new Date().toISOString();
                await logTransaction(id, "failed", apiTimestamp, err.message);
            }
            transactionList.unshift(...batch);
            await new Promise((resolve) => setTimeout(resolve, 60000));
        }
    }
    adjustFetchInterval();
};

// Adjust fetch interval dynamically
const adjustFetchInterval = () => {
    if (transactionList.length === 0) {
        fetchInterval = fetchInterval < 60000 ? 60000 : Math.min(fetchInterval * 2, 600000); // Max 15 min
        console.log(`Next fetch in: ${fetchInterval / 1000} sec`);
        setTimeout(processTransactions, fetchInterval);
    } else {
        fetchInterval = 10000; // Reset to 10 sec
    }
};

// Process transactions
const processTransactions = async () => {
    if (transactionList.length === 0) {
        await fetchTransactions();
    }
    await sendMessagesWithDelay();
};

// Start Telegram bot
(async () => {
    const stringSession = await loadSession();
    client = new TelegramClient(stringSession, apiId, apiHash, {
        connectionRetries: 10,
        retryDelay: 5000,
        floodSleepThreshold: 60,
        port: 443
    });

    client.on("error", async (err) => {
        console.error("Telegram client error:", err);
        ensureConnected();
    });

    await client.connect();

    if (!(await client.isUserAuthorized())) {
        console.error("No valid session. Please authenticate manually first.");
        process.exit(1);
    }

    console.log("Logged in as:", await client.getMe());
    await fetchTransactions();
    processTransactions();

    process.on("uncaughtException", (err) => console.error("Unhandled Error:", err));
    process.on("unhandledRejection", (reason) => console.error("Unhandled Rejection:", reason));
    process.on("SIGINT", async () => {
        console.log("Shutting down...");
        if (client) await client.disconnect();
        process.exit(0);
    });
})();