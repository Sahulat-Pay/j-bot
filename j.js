const axios = require("axios");
const express = require('express')
const app = express()
const port = process.env.PORT || 4000;

app.listen(port, () => {
    console.log(`Example app listening on port ${port}`)
})

app.get("/", (req,res,next) => {
  return res.status(200).json({status: "success"})
})

// API URLs for transactions
const CALLBACK_API_URL = "https://server.sahulatpay.com/backoffice/payin-callback";
const SETTLE_API_URL = "https://server.sahulatpay.com/backoffice/settle-transactions/tele";
const FAIL_API_URL = "https://server.sahulatpay.com/backoffice/fail-transactions/tele";
const FETCH_API_URL = "https://server.sahulatpay.com/transactions/tele/last-15-mins?status=failed&response_message=Transaction%20is%20Pending";

// List for transactions
let transaction = [];

// Set to track processed orders and prevent duplicates
const processedOrders = new Set();

// Retry function for API calls
const retry = async (fn, retries = 1, delay = 20) => {
  let lastError;
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (i === retries - 1) throw lastError;
      console.log(`Retry ${i + 1}/${retries} after error: ${error.message}`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
};

// Delay function to avoid rate limiting
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Function to log messages
const logMessage = (message) => {
  console.log(`[LOG]: ${message}`);
};

// Fetch transactions
const fetchTransactions = async () => {
  try {
    const response = await retry(() => axios.get(FETCH_API_URL, { timeout: 10000 }));
    if (!response.data || typeof response.data !== "object") return;

    let transactions = response.data.transactions || response.data;
    if (!Array.isArray(transactions)) return;

    let newTransactions = transactions
      .filter((tx) => !transaction.includes(tx.merchant_transaction_id) && !processedOrders.has(tx.merchant_transaction_id))
      .map((tx) => tx.merchant_transaction_id);

    transaction = [...transaction, ...newTransactions];
    console.log(`Fetched: ${newTransactions.length}, Total in transaction list: ${transaction.length}`);
  } catch (error) {
    console.error("Error fetching transactions:", error.message);
  }
};

// Function to handle the transaction
const handleTransaction = async (order) => {
  try {
    if (processedOrders.has(order)) {
      return;
    }
    processedOrders.add(order);
    setTimeout(() => processedOrders.delete(order), 30000); // Clear after 30s

    const apiUrl = `https://server.sahulatpay.com/transactions/tele?merchantTransactionId=${order}`;
    const response = await retry(() => axios.get(apiUrl));
    //console.log(`[${commandId}] API Response:`, response.data);

    let transaction = response.data.transactions?.[0];
    if (!transaction) {
      logMessage(`Transaction "${order}" not found in back-office.`);
      return;
    }

    //console.log(`[${commandId}] Transaction Details:`, JSON.stringify(transaction, null, 2));

    let status = transaction.status.trim().toLowerCase();
    let merchantTransactionId = transaction.merchant_transaction_id || transaction.merchant_custom_order_id;
    let txn_id = transaction.transaction_id;
    let uid = transaction.merchant?.uid || transaction.merchant?.groups?.[0]?.uid || transaction.merchant?.groups?.[0]?.merchant?.uid;

    if (status === "completed") {
      try {
        await retry(() => axios.post(CALLBACK_API_URL, { transactionIds: [merchantTransactionId] }));
        //console.log(`[${commandId}] Transaction ${merchantTransactionId} marked as completed. TxnID: ${txn_id}`);
        logMessage(`Transaction Status ${merchantTransactionId} : Completed.\n\nTxnID: ${txn_id}`);
      } catch (error) {
        logMessage(`Error updating transaction status for ${merchantTransactionId}.`);
      }
      return;
    }

    // Status inquiry for transactions
    if (uid) {
      let providerName = transaction.providerDetails?.name?.toLowerCase();
      let inquiryUrl, inquiryResponse;

      if (providerName === "easypaisa") {
        inquiryUrl = `https://server.sahulatpay.com/payment/inquiry-ep/${uid}?orderId=${order}`;
        inquiryResponse = await retry(() => axios.get(inquiryUrl, { params: { transaction_id: merchantTransactionId } }));
      } else if (providerName === "jazzcash") {
        inquiryUrl = `https://server.sahulatpay.com/payment/status-inquiry/${uid}`;
        inquiryResponse = await retry(() => axios.post(inquiryUrl, { transactionId: merchantTransactionId }));
      }

      if (inquiryResponse) {
        //console.log(`[${commandId}] Inquiry API Response:`, inquiryResponse.data);
        let inquiryStatus = inquiryResponse?.data?.data?.transactionStatus?.toLowerCase();
        let inquiryStatusCode = inquiryResponse?.data?.data?.statusCode;

        if (!inquiryStatus || inquiryStatus === "failed" || inquiryStatusCode === 500) {
          await retry(() => axios.post(FAIL_API_URL, { transactionIds: [merchantTransactionId] }));
          //console.log(`[${commandId}] Transaction ${merchantTransactionId} marked as failed.`);
          logMessage(`${merchantTransactionId} Status: Failed.`);
          return;
        } else if (inquiryStatus === "completed") {
          await retry(() => axios.post(SETTLE_API_URL, { transactionId: merchantTransactionId }));
          //console.log(`[${commandId}] Transaction ${merchantTransactionId} marked as completed.`);
          logMessage(`Transaction Status ${merchantTransactionId} : Completed.`);
          return;
        }
      }
    }

    // Default case: transaction failed
    logMessage(`${merchantTransactionId} Status: Failed.`);
  } catch (error) {
    logMessage(`Error: ${error.message}`);
  }
};

// Function to process transaction list
const processTransactionList = async () => {
  console.log("Processing transaction list:", transaction);
  while (transaction.length > 0) {
    const order = transaction[0]; // Peek at the first order
    transaction.shift(); // Remove it immediately to prevent reprocessing
    await handleTransaction(order);
    await delay(10); // Delay between transactions
  }
};

// Main loop to fetch and process every 3 minutes
const main = async () => {
  while (true) {
    console.log("Starting fetch cycle...");
    await fetchTransactions();
    await processTransactionList();
    console.log("Waiting 2 minutes for next fetch...");
    await delay(120000); // Wait 2 minutes (120000 ms)
  }
};

// Run the script
main().catch((error) => {
  console.error("Error in main loop:", error);
});

// Handle uncaught exceptions and rejections to prevent crashes
process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
});

process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
});
